import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BrowserChatContextRecords1788566400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS browser_chat_context_record (
      session_id TEXT NOT NULL REFERENCES browser_chat_session(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS browser_chat_context_request (
      session_id TEXT NOT NULL REFERENCES browser_chat_session(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )`);
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query('DROP TABLE IF EXISTS browser_chat_context_request');
    await queryRunner.query('DROP TABLE IF EXISTS browser_chat_context_record');
  }
}
