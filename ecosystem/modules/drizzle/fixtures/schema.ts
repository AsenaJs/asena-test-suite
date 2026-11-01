import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const suiteUsers = pgTable('suite_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  tag: text('tag'),
});

export type SuiteUsers = typeof suiteUsers;

export function createTableSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS "${schema}".suite_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    tag TEXT
  )`;
}
