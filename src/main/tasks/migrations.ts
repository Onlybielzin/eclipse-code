/**
 * Migracoes do SQLite do app novo. Cada entrada roda uma vez, em ordem, dentro de
 * uma transacao, e avanca PRAGMA user_version. Nunca edite uma migracao ja publicada:
 * acrescente outra.
 *
 * Invariantes que o proprio banco garante (defesa em profundidade; o TaskService
 * ja recusa antes com DomainError):
 *   - subtarefa em estado final nao muda (trigger subtasks_final_immutable).
 *   - no maximo um Lider (leader-pty) nao encerrado por tarefa (indice parcial).
 *   - no maximo um papel Lider ativo por projeto e nome de papel unico por projeto.
 *   - entregas (artifacts) e atividade nunca sao alteradas (triggers *_append_only).
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'esquema inicial',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE roles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        description TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        model TEXT,
        prompt_template TEXT NOT NULL,
        is_lead INTEGER NOT NULL CHECK (is_lead IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE UNIQUE INDEX roles_name_unique ON roles(project_id, name_key) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX roles_one_lead ON roles(project_id) WHERE is_lead = 1 AND deleted_at IS NULL;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        context_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('team', 'solo')),
        worktree_path TEXT,
        branch TEXT,
        base_branch TEXT,
        lead_role_id TEXT REFERENCES roles(id),
        solo_provider TEXT CHECK (solo_provider IS NULL OR solo_provider IN ('claude', 'codex')),
        status TEXT NOT NULL CHECK (status IN ('open', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX tasks_by_project ON tasks(project_id, status, created_at);

      CREATE TABLE subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id),
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN
          ('submitted', 'working', 'input_required', 'completed', 'failed', 'canceled')),
        status_message TEXT,
        failure_code TEXT,
        reference_task_ids TEXT NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX subtasks_by_task ON subtasks(task_id, created_at);
      CREATE TRIGGER subtasks_final_immutable
        BEFORE UPDATE ON subtasks
        WHEN OLD.state IN ('completed', 'failed', 'canceled')
        BEGIN SELECT RAISE(ABORT, 'final_state: subtarefa em estado final nao muda'); END;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subtask_id TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
        role_id TEXT REFERENCES roles(id),
        kind TEXT NOT NULL CHECK (kind IN ('leader-pty', 'member-acp')),
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        model TEXT,
        cwd TEXT NOT NULL,
        provider_session_id TEXT,
        pid INTEGER,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'exited')),
        active_turn_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        exit_code INTEGER
      );
      CREATE INDEX sessions_by_task ON sessions(task_id, started_at);
      CREATE INDEX sessions_open ON sessions(status) WHERE status <> 'exited';
      CREATE UNIQUE INDEX sessions_one_live_leader
        ON sessions(task_id) WHERE kind = 'leader-pty' AND status <> 'exited';

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        stop_reason TEXT,
        error_json TEXT,
        final_text TEXT
      );
      CREATE INDEX turns_by_subtask ON turns(subtask_id, started_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('leader', 'member', 'user', 'system')),
        parts_json TEXT NOT NULL,
        turn_id TEXT,
        created_at INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX messages_by_subtask ON messages(subtask_id, seq);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        format TEXT NOT NULL CHECK (format IN ('structured', 'unformatted')),
        delivery_json TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX artifacts_by_subtask ON artifacts(subtask_id, seq);
      CREATE INDEX artifacts_by_turn ON artifacts(turn_id, seq);
      CREATE TRIGGER artifacts_append_only
        BEFORE UPDATE ON artifacts
        BEGIN SELECT RAISE(ABORT, 'entrega gravada nao muda'); END;

      CREATE TABLE activity (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX activity_by_subtask ON activity(subtask_id, seq);
      CREATE INDEX activity_by_turn ON activity(turn_id, seq);
      CREATE TRIGGER activity_append_only
        BEFORE UPDATE ON activity
        BEGIN SELECT RAISE(ABORT, 'atividade gravada nao muda'); END;

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subtask_id TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
        items_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'dismissed')),
        answers_json TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX questions_open ON questions(task_id) WHERE status = 'open';

      CREATE TABLE events (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'fila duravel de avisos ao Lider',
    sql: `
      CREATE TABLE leader_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX leader_notices_pending ON leader_notices(task_id, id) WHERE delivered_at IS NULL;
    `,
  },
  {
    version: 3,
    name: 'status de trabalho da tarefa',
    sql: `
      ALTER TABLE tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'a_fazer'
        CHECK (workflow_status IN
          ('a_fazer', 'em_andamento', 'pergunta', 'em_revisao', 'pronto_lancar', 'lancado'));
      UPDATE tasks SET workflow_status = 'lancado' WHERE status = 'archived';
    `,
  },
  {
    version: 4,
    name: 'perguntas substituidas e respondidas no terminal',
    // SQLite nao altera CHECK: recria a tabela com os dois status novos e copia as linhas.
    // Nenhuma tabela aponta para questions, entao trocar a tabela nao quebra chave estrangeira.
    sql: `
      CREATE TABLE questions_v4 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subtask_id TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
        items_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('open', 'answered', 'dismissed', 'superseded', 'answered_in_terminal')),
        answers_json TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      INSERT INTO questions_v4 (id, task_id, subtask_id, items_json, status, answers_json,
        created_at, answered_at)
        SELECT id, task_id, subtask_id, items_json, status, answers_json, created_at, answered_at
        FROM questions ORDER BY rowid;
      DROP TABLE questions;
      ALTER TABLE questions_v4 RENAME TO questions;
      CREATE INDEX questions_open ON questions(task_id) WHERE status = 'open';
    `,
  },
  {
    version: 5,
    name: 'configuracoes do app',
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: 'aviso ao Lider guarda a subtarefa',
    // Sem FK: aviso de subtarefa apagada continua legivel; NULL para aviso sem subtarefa.
    sql: `ALTER TABLE leader_notices ADD COLUMN subtask_id TEXT;`,
  },
  {
    version: 7,
    name: 'comando de iniciar por tarefa',
    sql: `
      ALTER TABLE tasks ADD COLUMN start_command TEXT;
      ALTER TABLE tasks ADD COLUMN start_dir TEXT;
    `,
  },
  {
    version: 8,
    name: 'acesso por papel',
    // name_key segue roleNameKey: sem acento e minusculo. O Lider nunca muda.
    sql: `
      ALTER TABLE roles ADD COLUMN access TEXT NOT NULL DEFAULT 'full'
        CHECK (access IN ('full','no_commit','read_only'));
      UPDATE roles SET access = 'read_only' WHERE name_key = 'revisor' AND is_lead = 0;
      UPDATE roles SET access = 'no_commit' WHERE name_key = 'dev' AND is_lead = 0;
    `,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0
