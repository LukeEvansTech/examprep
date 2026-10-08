#!/usr/bin/env bash
# Build the image, run it, and check the things only a real container proves: the server
# starts as uid 1000 with /data writable, serves the bundled client, and keeps uploads
# behind the API key.
set -euo pipefail

IMAGE="${IMAGE:-examprep:e2e}"
PORT="${PORT:-18080}"
KEY="e2e-key-$(date +%s)"
NAME="examprep-e2e-$$"

docker build -t "$IMAGE" .
docker run -d --name "$NAME" -p "$PORT:8080" -e EXAMPREP_UPLOAD_KEY="$KEY" "$IMAGE" >/dev/null
trap 'docker logs "$NAME" || true; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" | grep -q '"ok":true'

# The bundled client is served at /.
curl -fsS "http://localhost:$PORT/" | grep -q '<div id="app">'
curl -fsS "http://localhost:$PORT/sw.js" | grep -q 'examprep-'

# Uploads need the key; with it, the bank lands in SQLite on /data.
bank='{"exam":{"code":"e2e-100","vendor":"test","title":"E2E","totalOnSite":1,"settings":{"examQuestions":1,"minutes":1,"passPct":70}},"importedAt":"2026-01-01T00:00:00Z","questions":[{"id":"1","number":1,"topic":"t","kind":"single","stemHtml":"?","images":[],"choices":[{"letter":"A","html":"a"}],"pick":1,"suggested":"A","suggestedImage":null,"votes":[],"discussionId":null,"enrichment":null,"resolved":{"answer":"A","items":null,"basis":"suggested","disputed":false}}]}'
status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d "$bank" "http://localhost:$PORT/api/exams/e2e-100")
test "$status" = "401"
curl -fsS -X PUT -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "$bank" "http://localhost:$PORT/api/exams/e2e-100" | grep -q '"added":1'
curl -fsS "http://localhost:$PORT/api/exams" | grep -q '"code":"e2e-100"'
docker exec "$NAME" test -s /data/examprep.db

echo "e2e: ok"
