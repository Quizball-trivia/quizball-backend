// Lex SQL only to classify top-level statements. SQL bodies are sent unchanged.
// Comments and quoted bodies must not turn ordinary DDL into online DDL.
export function sqlStatements(body) {
  const statements = [];
  let code = '', rawStart = 0, i = 0;
  const finish = (end) => {
    if (code.trim()) statements.push({ sql: body.slice(rawStart, end), code: code.trim() });
    rawStart = end; code = '';
  };
  while (i < body.length) {
    if (body.startsWith('--', i)) {
      const end = body.indexOf('\n', i + 2);
      i = end < 0 ? body.length : end; code += ' '; continue;
    }
    if (body.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < body.length && depth) {
        if (body.startsWith('/*', i)) { depth++; i += 2; }
        else if (body.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      code += ' '; continue;
    }
    const dollar = body.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = body.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      i = end + dollar.length; code += ' ? '; continue;
    }
    if (body[i] === "'" || body[i] === '"') {
      const quote = body[i], start = i;
      const escape = quote === "'" && /(?:^|[^A-Za-z_0-9])[eE]$/.test(body.slice(0, i));
      i++; let closed = false;
      while (i < body.length) {
        if (escape && body[i] === '\\') { i += 2; continue; }
        if (body[i] === quote) {
          if (body[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      code += quote === '"' ? body.slice(start, i) : ' ? ';
      continue;
    }
    code += body[i++];
    if (body[i - 1] === ';') finish(i);
  }
  finish(i);
  return statements;
}

export function classifyMigration(body) {
  const statements = sqlStatements(body);
  const online = statements.some(({code}) => /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\b[\s\S]*\bCONCURRENTLY\b|VACUUM\b)/i.test(code));
  const optOut = /^\s*--\s*migrate:no-transaction\b/im.test(body);
  if (online && statements.length !== 1) {
    throw new Error('Online DDL must be a standalone SQL statement in its migration file');
  }
  if ((online || optOut) && statements.some(({code}) => /^SET\s+LOCAL\b/i.test(code))) {
    throw new Error('SET LOCAL is ineffective outside a transaction');
  }
  if (statements.some(({code}) => /^(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i.test(code))) {
    throw new Error('The runner owns transaction boundaries');
  }
  return { nonTransactional: online || optOut, statements };
}

export function migrationConnection(env) {
  const app = env.DATABASE_URL || env.STAGING_DATABASE_URL;
  const selected = env.MIGRATION_DATABASE_URL || app;
  if (!selected) throw new Error('A migration database URL is required');
  const url = new URL(selected);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URL');
  if ((url.hostname.endsWith('.pooler.supabase.com') || /^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname)) && url.port === '6543') {
    throw new Error('Migrations require the session pooler; set MIGRATION_DATABASE_URL to port 5432');
  }
  const refOf = (value) => {
    const u = new URL(value);
    return u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1]
      ?? decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/)?.[1];
  };
  if (app && refOf(app) && refOf(selected) !== refOf(app)) throw new Error('Application and migration database projects differ');
  if (env.MIGRATION_EXPECTED_PROJECT_REF && refOf(selected) !== env.MIGRATION_EXPECTED_PROJECT_REF) {
    throw new Error('Migration database does not match the expected project');
  }
  return selected;
}

export function timeoutMs(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3600000) {
    throw new Error(`${name} must be an integer from 1 to 3600000 milliseconds`);
  }
  return Number(value);
}
