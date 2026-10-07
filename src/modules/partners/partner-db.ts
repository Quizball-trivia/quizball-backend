import type { sql, TransactionSql } from '../../db/index.js';

export type Db = typeof sql;

/** postgres.js's TransactionSql type drops the tagged-template call signature; at runtime it is the same callable. */
export const asSql = (tx: TransactionSql): Db => tx as unknown as Db;
