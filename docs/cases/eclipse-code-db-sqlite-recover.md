# Eclipse Code DB SQLite Recover

Use `pnpm recover:eclipse-code-db` when SQLite can still produce a `.recover` dump and you need to rebuild an Eclipse Code profile database offline.

## Inputs

- `--recover-sql`: output from `sqlite3 /path/to/eclipse-code.db ".recover"`.
- `--source-db`: original damaged database, used to preserve `app_settings`, browser profile data, and current app metadata.
- `--output-db`: rebuilt database path.

## Selector

Pick the target workspace with one of:

- `--workspace-id`
- `--workspace-name` plus `--workspace-path`

## Example

```bash
sqlite3 /path/to/eclipse-code.db ".recover" > /path/to/eclipse-code-recover.sql
pnpm recover:eclipse-code-db -- \
  --recover-sql /path/to/eclipse-code-recover.sql \
  --source-db /path/to/eclipse-code.db \
  --output-db /path/to/eclipse-code-rebuilt.db \
  --workspace-name cove \
  --workspace-path /path/to/workspace
```

## Notes

- The script writes a fresh SQLite database; it does not modify the source file.
- It keeps the selected workspace and related nodes/spaces, plus browser profile tables when present.
- If the source database contains multiple workspaces, the selector must be unambiguous.
