import { type Admin, type Consumer, Kafka, logLevel } from 'kafkajs';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import type { TransportAdmin } from './testbed.ts';

export const KAFKA_RESTART_ENV = 'ASENA_SUITE_KAFKA_RESTART_CMD';

// Raw Kafka access for setup and assertions the transport does not expose. Every topic and group it touches starts with
// this bed's topic prefix.
export class KafkaAdmin implements TransportAdmin {
  private kafka: Kafka;

  private client?: Admin;

  public constructor(
    brokers: string[],
    private readonly topicPrefix: string,
  ) {
    this.kafka = new Kafka({ clientId: 'asena-suite-admin', brokers, logLevel: logLevel.NOTHING });
  }

  public get dlqTopic(): string {
    return `${this.topicPrefix}.dlq`;
  }

  public groupId(serviceName: string): string {
    return `${this.topicPrefix}.${serviceName}`;
  }

  public async dlqCount(): Promise<number> {
    try {
      const offsets = await (await this.admin()).fetchTopicOffsets(this.dlqTopic);

      return offsets.reduce((sum, partition) => sum + (Number(partition.high) - Number(partition.low)), 0);
    } catch {
      return 0;
    }
  }

  public async dlqEntries(): Promise<Record<string, string>[]> {
    const count = await this.dlqCount();

    if (count === 0) return [];

    const groupId = `${this.topicPrefix}.dlq-reader.${crypto.randomUUID().slice(0, 8)}`;
    const consumer: Consumer = this.kafka.consumer({ groupId, sessionTimeout: 6000, heartbeatInterval: 1500 });
    const records: Record<string, string>[] = [];

    await consumer.connect();

    try {
      await consumer.subscribe({ topics: [this.dlqTopic], fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ message }) => {
          const record: Record<string, string> = {};

          for (const [key, value] of Object.entries(message.headers ?? {})) {
            if (value !== undefined) record[key] = String(value);
          }

          record.d = message.value ? message.value.toString() : '';
          records.push(record);
        },
      });
      await waitFor(() => records.length >= count, { timeout: 15_000, interval: 100, label: 'DLQ records read' });
    } finally {
      await consumer.disconnect().catch(() => {});
      await (await this.admin()).deleteGroups([groupId]).catch(() => {});
    }

    return records;
  }

  // Kafka refuses to delete a non-empty group: the scenario stops the service's replicas first.
  public async destroyDeliveryState(serviceName: string): Promise<void> {
    await (await this.admin()).deleteGroups([this.groupId(serviceName)]);
  }

  // Kafka has no server-side client kill and clients dial the advertised listener directly, so the only honest blip is a
  // broker restart. It is container-global and disturbs every other user of the broker, hence the slow gate on the
  // scenarios that call it and the explicit command (e.g. `docker restart <container>`).
  public async severConnections(): Promise<void> {
    const command = process.env[KAFKA_RESTART_ENV]?.trim();

    if (!command) throw new Error(`${KAFKA_RESTART_ENV} is not set: no command to restart the Kafka broker`);

    const restart = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });

    if ((await restart.exited) !== 0) {
      throw new Error(`'${command}' exited ${restart.exitCode}: ${await new Response(restart.stderr).text()}`);
    }

    await this.disconnect();
    await waitFor(
      async () => {
        try {
          await (await this.admin()).listTopics();

          return true;
        } catch {
          await this.disconnect();

          return false;
        }
      },
      { timeout: 60_000, interval: 500, label: 'broker serving again after the restart' },
    );
  }

  public async sweepNamespace(): Promise<void> {
    const admin = await this.admin();
    const topics = (await admin.listTopics().catch(() => [] as string[])).filter((topic) =>
      topic.startsWith(this.topicPrefix),
    );

    if (topics.length) await admin.deleteTopics({ topics }).catch(() => {});

    const { groups } = await admin.listGroups().catch(() => ({ groups: [] as { groupId: string }[] }));
    const mine = groups.map((group) => group.groupId).filter((groupId) => groupId.startsWith(this.topicPrefix));

    if (mine.length) await admin.deleteGroups(mine).catch(() => {});
  }

  public async fetchGroupOffsets(serviceName: string, topics?: string[]) {
    return (await this.admin()).fetchOffsets({ groupId: this.groupId(serviceName), ...(topics && { topics }) });
  }

  public async disconnect(): Promise<void> {
    await this.client?.disconnect().catch(() => {});
    this.client = undefined;
  }

  private async admin(): Promise<Admin> {
    if (!this.client) {
      const client = this.kafka.admin();

      await client.connect();
      this.client = client;
    }

    return this.client;
  }
}
