/**
 * postgres.js's `TransactionSql` is declared as `Omit<Sql, ...>`, and `Omit`
 * strips a type's call signatures — so a `TransactionSql` value cannot be used
 * as a tagged-template tag under `strict` even though it is callable at runtime.
 * The app repos sidestep this by using `tx.unsafe(...)`; this roster code prefers
 * tagged templates for parameterization safety, so we re-attach the two call
 * signatures via intersection.
 */

import type postgres from 'postgres';

type TaggedQuery = {
  <T extends readonly (object | undefined)[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): postgres.PendingQuery<T>;
};

/** A transaction handle usable as a tagged-template tag. */
export type Tx = postgres.TransactionSql & TaggedQuery;

/**
 * A pool handle. `postgres.Sql` already declares its call signatures (only
 * `TransactionSql` loses them to `Omit`), so no re-attachment is needed here.
 */
export type SqlLike = postgres.Sql;
