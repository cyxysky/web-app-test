import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep read indexes in the same transaction as every writer, including imports and other processes. */
export class RuntimeReadIndexes1788652800000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    const postgres = runner.connection.options.type === 'postgres';
    await runner.query(`CREATE TABLE browser_chat_file_message (
      session_id TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY(session_id, id),
      FOREIGN KEY(session_id, id) REFERENCES browser_chat_message(session_id, id) ON DELETE CASCADE
    )`);
    await runner.query('CREATE INDEX browser_chat_file_message_time ON browser_chat_file_message(session_id, time, id)');
    const projection = (row: string) => {
      const json = postgres ? `CAST(${row}.record_json AS jsonb)` : `${row}.record_json`;
      const field = (key: string) => postgres ? `${json}->'${key}'` : `json_extract(${json}, '$.${key}')`;
      return postgres
        ? `jsonb_build_object('id', ${row}.id, 'role', ${field('role')}, 'createdAt', ${field('createdAt')}, 'updatedAt', ${field('updatedAt')}, 'content', '', 'attachments', ${field('attachments')}, 'artifacts', ${field('artifacts')})::text`
        : `json_object('id', ${row}.id, 'role', ${field('role')}, 'createdAt', ${field('createdAt')}, 'updatedAt', ${field('updatedAt')}, 'content', '', 'attachments', json(COALESCE(${field('attachments')}, '[]')), 'artifacts', json(COALESCE(${field('artifacts')}, '[]')))`;
    };
    const hasFiles = (row: string) => postgres
      ? `(COALESCE(CAST(${row}.record_json AS jsonb)->'attachments', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb) OR COALESCE(CAST(${row}.record_json AS jsonb)->'artifacts', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb))`
      : `(COALESCE(json_array_length(${row}.record_json, '$.attachments'), 0)>0 OR COALESCE(json_array_length(${row}.record_json, '$.artifacts'), 0)>0)`;
    await runner.query(`INSERT INTO browser_chat_file_message SELECT m.session_id, m.id, m.time, ${projection('m')} FROM browser_chat_message m WHERE ${hasFiles('m')}`);
    const upsert = `INSERT INTO browser_chat_file_message VALUES (NEW.session_id, NEW.id, NEW.time, ${projection('NEW')})
      ON CONFLICT(session_id,id) DO UPDATE SET time=excluded.time, record_json=excluded.record_json`;
    if (postgres) {
      await runner.query(`CREATE FUNCTION webpilot_index_message_files() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ${hasFiles('NEW')} THEN ${upsert};
        ELSE DELETE FROM browser_chat_file_message WHERE session_id=NEW.session_id AND id=NEW.id; END IF;
        RETURN NULL; END $$`);
      await runner.query('CREATE TRIGGER webpilot_message_files AFTER INSERT OR UPDATE OF record_json ON browser_chat_message FOR EACH ROW EXECUTE FUNCTION webpilot_index_message_files()');
    } else {
      for (const operation of ['INSERT', 'UPDATE']) await runner.query(`CREATE TRIGGER webpilot_message_files_${operation.toLowerCase()}
        AFTER ${operation} ON browser_chat_message BEGIN
          DELETE FROM browser_chat_file_message WHERE session_id=NEW.session_id AND id=NEW.id;
          INSERT INTO browser_chat_file_message SELECT NEW.session_id, NEW.id, NEW.time, ${projection('NEW')} WHERE ${hasFiles('NEW')};
        END`);
    }

    await runner.query('CREATE TABLE runtime_knowledge_revision (scope TEXT NOT NULL, kind TEXT NOT NULL, revision BIGINT NOT NULL, PRIMARY KEY(scope,kind))');
    for (const [table, kind] of [['skill', 'skills'], ['personal_memory_item', 'memories']]) {
      const bump = (row: string) => `INSERT INTO runtime_knowledge_revision(scope,kind,revision) VALUES ('user:' || ${row}.user_id, '${kind}', 1)
        ON CONFLICT(scope,kind) DO UPDATE SET revision=runtime_knowledge_revision.revision+1;
        INSERT INTO runtime_knowledge_revision(scope,kind,revision) SELECT 'shared', '${kind}', 1 WHERE ${row}.shared = ${postgres ? 'true' : '1'}
        ON CONFLICT(scope,kind) DO UPDATE SET revision=runtime_knowledge_revision.revision+1;`;
      if (postgres) {
        await runner.query(`CREATE FUNCTION webpilot_revision_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP <> 'INSERT' THEN ${bump('OLD')} END IF;
          IF TG_OP <> 'DELETE' THEN ${bump('NEW')} END IF;
          RETURN NULL; END $$`);
        await runner.query(`CREATE TRIGGER webpilot_revision_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION webpilot_revision_${table}()`);
      } else {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) await runner.query(`CREATE TRIGGER webpilot_revision_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN ${operation !== 'INSERT' ? bump('OLD') : ''} ${operation !== 'DELETE' ? bump('NEW') : ''} END`);
      }
    }
  }

  async down(runner: QueryRunner) {
    const postgres = runner.connection.options.type === 'postgres';
    for (const table of ['skill', 'personal_memory_item']) {
      if (postgres) {
        await runner.query(`DROP TRIGGER IF EXISTS webpilot_revision_${table} ON ${table}`);
        await runner.query(`DROP FUNCTION IF EXISTS webpilot_revision_${table}()`);
      } else for (const op of ['insert', 'update', 'delete']) await runner.query(`DROP TRIGGER IF EXISTS webpilot_revision_${table}_${op}`);
    }
    if (postgres) {
      await runner.query('DROP TRIGGER IF EXISTS webpilot_message_files ON browser_chat_message');
      await runner.query('DROP FUNCTION IF EXISTS webpilot_index_message_files()');
    } else for (const op of ['insert', 'update']) await runner.query(`DROP TRIGGER IF EXISTS webpilot_message_files_${op}`);
    await runner.query('DROP TABLE runtime_knowledge_revision');
    await runner.query('DROP TABLE browser_chat_file_message');
  }
}
