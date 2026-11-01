const name = process.argv[2] ?? './b.ts';

export const loaded = await import(name);
