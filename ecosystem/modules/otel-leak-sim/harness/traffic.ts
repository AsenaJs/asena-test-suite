type Task = () => Promise<void>;

interface Persona {
  tasks: Task[];
  uniqueUnmatched: number;
}

const rand = () => Math.random().toString(36).slice(2, 10);

function randomTraceparent(): string {
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

  return `00-${hex(32)}-${hex(16)}-01`;
}

const SCANNER_WORDLIST = [
  '/wp-admin/user/index.php',
  '/wp-content/themes/hideo/network.php',
  '/wp-login.php',
  '/wp-includes/wlwmanifest.xml',
  '/.env',
  '/.env.local',
  '/.env.production',
  '/.git/config',
  '/.git/HEAD',
  '/xmlrpc.php',
  '/phpmyadmin/index.php',
  '/pma/index.php',
  '/administrator/index.php',
  '/admin/config.php',
  '/actuator',
  '/actuator/health',
  '/actuator/env',
  '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
  '/cgi-bin/test.cgi',
  '/owa/auth/logon.aspx',
  '/solr/admin/info/system',
  '/.aws/credentials',
  '/.ssh/id_rsa',
  '/config.json',
  '/backup.zip',
  '/database.sql',
  '/console',
  '/login/',
  '/manager/html',
  '/telescope/requests',
  '/_ignition/execute-solution',
  '/api/.env',
  '/s3cmd.ini',
  '/.DS_Store',
  '/robots.txt.bak',
  '/wp-json/wp/v2/users',
  '/phpinfo.php',
  '/info.php',
  '/shell.php',
  '/eval.php',
];

async function runBatch(tasks: Task[], concurrency: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;

      await tasks[index]();
    }
  });

  await Promise.all(workers);
}

async function safeFetch(url: string, init?: RequestInit): Promise<void> {
  try {
    const response = await fetch(url, init);

    await response.arrayBuffer();
  } catch {
    // connection churn under load carries no leak signal
  }
}

function normalUsers(baseUrl: string, n: number, tag: string): Persona {
  const tasks: Task[] = [];
  const createdIds: string[] = [];

  for (let i = 0; i < n; i++) {
    const roll = i % 6;

    if (roll === 0) {
      tasks.push(() => safeFetch(`${baseUrl}/health`));
    } else if (roll === 1) {
      tasks.push(() => safeFetch(`${baseUrl}/api/users?page=${i}&search=${rand()}`));
    } else if (roll === 2) {
      const body = JSON.stringify({
        name: `user-${tag}-${i}-${rand()}`,
        email: `${rand()}@example.com`,
        age: 20 + (i % 40),
      });

      tasks.push(async () => {
        try {
          const response = await fetch(`${baseUrl}/api/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });

          if (response.status === 201) {
            const json = (await response.json()) as { id?: string };

            if (json.id) createdIds.push(json.id);
          } else {
            await response.arrayBuffer();
          }
        } catch {
          // see safeFetch
        }
      });
    } else if (roll === 3) {
      tasks.push(() =>
        safeFetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '', email: 'not-an-email' }),
        }),
      );
    } else if (roll === 4) {
      const id = createdIds.length && i % 2 === 0 ? createdIds[i % createdIds.length] : crypto.randomUUID();

      tasks.push(() => safeFetch(`${baseUrl}/api/users/${id}`));
    } else {
      const id = crypto.randomUUID();
      const init: RequestInit =
        i % 2 === 0
          ? {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: `upd-${rand()}` }),
            }
          : { method: 'DELETE' };

      tasks.push(() => safeFetch(`${baseUrl}/api/users/${id}`, init));
    }
  }

  return { tasks, uniqueUnmatched: 0 };
}

function attackers(baseUrl: string, n: number, tag: string): Persona {
  const tasks: Task[] = [];

  for (let i = 0; i < n; i++) {
    const roll = i % 6;

    if (roll === 0) {
      tasks.push(() => safeFetch(`${baseUrl}/../../etc/passwd-${tag}-${i}-${rand()}`));
    } else if (roll === 1) {
      tasks.push(() => safeFetch(`${baseUrl}/%61%64%6d%69%6e-${tag}-${i}-${rand()}`));
    } else if (roll === 2) {
      const method = ['POST', 'PUT', 'DELETE', 'PATCH'][i % 4];

      tasks.push(() => safeFetch(`${baseUrl}/fuzz-${tag}-${i}-${rand()}`, { method }));
    } else if (roll === 3) {
      tasks.push(() =>
        safeFetch(`${baseUrl}/probe-${tag}-${i}-${rand()}`, {
          headers: { traceparent: randomTraceparent(), 'x-forwarded-for': `${i}.${i}.${i}.${i}` },
        }),
      );
    } else if (roll === 4) {
      const junk = 'q'.repeat(2000 + (i % 2000));

      tasks.push(() => safeFetch(`${baseUrl}/search-${tag}-${i}-${rand()}?data=${junk}`));
    } else {
      const variant = i % 2 === 0 ? `/API/Users-${tag}-${i}-${rand()}/` : `/HeAlTh-${tag}-${i}-${rand()}`;

      tasks.push(() => safeFetch(`${baseUrl}${variant}`, { headers: { 'user-agent': 'x'.repeat(1024) } }));
    }
  }

  return { tasks, uniqueUnmatched: n };
}

function scanners(baseUrl: string, n: number, tag: string): Persona {
  const tasks: Task[] = [];

  for (let i = 0; i < n; i++) {
    const base = SCANNER_WORDLIST[i % SCANNER_WORDLIST.length];

    tasks.push(() => safeFetch(`${baseUrl}${base}-${tag}-${i}-${rand()}`));
  }

  return { tasks, uniqueUnmatched: n };
}

export interface WaveConfig {
  normal: number;
  attacker: number;
  scanner: number;
  tag: string;
}

export async function runWave(baseUrl: string, config: WaveConfig, concurrency = 25): Promise<number> {
  const personas = [
    normalUsers(baseUrl, config.normal, config.tag),
    attackers(baseUrl, config.attacker, config.tag),
    scanners(baseUrl, config.scanner, config.tag),
  ];
  const all = personas.flatMap((persona) => persona.tasks);

  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [all[i], all[j]] = [all[j], all[i]];
  }

  await runBatch(all, concurrency);

  return personas.reduce((sum, persona) => sum + persona.uniqueUnmatched, 0);
}
