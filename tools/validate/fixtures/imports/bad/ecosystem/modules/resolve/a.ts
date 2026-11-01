const name = process.argv[2] ?? '@asenajs/asena';

export const where = Bun.resolveSync(name, import.meta.dir);
