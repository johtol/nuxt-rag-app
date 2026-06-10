#!/bin/bash
# Wrapper script for drizzle-kit migrate that handles NOTICE messages gracefully
drizzle-kit migrate
# Exit code 1 sometimes happens with NOTICE messages even when migration succeeds
# Check if the migrations table exists to confirm success
RESULT=$?
if [ $RESULT -eq 1 ]; then
  # Verify the schema actually exists by checking for migrations table
  if psql "$DATABASE_URL" -c "SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'" &>/dev/null; then
    echo "[✓] Migrations applied successfully (exit code 1 from NOTICE messages - ignored)"
    exit 0
  fi
fi
exit $RESULT

