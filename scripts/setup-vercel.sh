#!/usr/bin/env bash
# Creates the Vercel project, a private Blob store, and the production env vars for Wardrobe,
# seeds the store from data/, and deploys. Run it after `vercel login` as the account that should own the app.
# Usage: scripts/setup-vercel.sh [project-name]
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${1:-wardrobe}"
[ -f .env ] || { echo "No .env found. Copy .env.example and fill it in first." >&2; exit 1; }
set -a; . ./.env; set +a
for name in OPENAI_API_KEY OPENAI_VISION_MODEL OPENAI_IMAGE_MODEL OPENAI_IMAGE_QUALITY WARDROBE_IMPORT_SECRET; do
  [ -n "${!name:-}" ] || { echo "$name is empty in .env" >&2; exit 1; }
done

auth_file="$HOME/Library/Application Support/com.vercel.cli/auth.json"
[ -f "$auth_file" ] || auth_file="$HOME/.local/share/com.vercel.cli/auth.json"
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")' "$auth_file")
[ -n "$TOKEN" ] || { echo "Not logged in. Run: vercel login" >&2; exit 1; }
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

echo "Account: $(api https://api.vercel.com/v2/user | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const u=JSON.parse(d).user;console.log(u.username,"<"+u.email+">")})')"

# Hobby accounts expose their personal scope as a team, and the CLI needs it named when more than one is available.
SCOPE="${VERCEL_SCOPE:-$(api https://api.vercel.com/v2/teams | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).teams||[];console.log(t.length===1?t[0].slug:"")})')}"
[ -n "$SCOPE" ] || { echo "Several Vercel scopes are available. Rerun with VERCEL_SCOPE=<team-slug>." >&2; exit 1; }
echo "Scope: $SCOPE"

rm -rf .vercel
vercel project add "$PROJECT" --scope "$SCOPE" >/dev/null 2>&1 || true
vercel link --yes --project "$PROJECT" --scope "$SCOPE" >/dev/null
PROJECT_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".vercel/project.json","utf8")).projectId)')
TEAM_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".vercel/project.json","utf8")).orgId)')
echo "Project: $PROJECT ($PROJECT_ID)"

# Public gallery on the default URL, so Vercel's login wall stays off. Vite is detected anyway; pin it to be explicit.
api -X PATCH "https://api.vercel.com/v9/projects/$PROJECT_ID?teamId=$TEAM_ID" -d '{"framework":"vite","ssoProtection":null}' >/dev/null
echo "Project settings: framework vite, deployment protection off"

# Reuse a store with the project's name so reruns stay idempotent. The CLI creates a store but then asks
# interactively whether to link it, so the link happens through the API instead.
STORE_ID=$(api "https://api.vercel.com/v1/storage/stores?teamId=$TEAM_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=(JSON.parse(d).stores||[]).find(x=>x.name===process.argv[1]&&x.type==="blob");console.log(s?s.id:"")})' "$PROJECT")
if [ -z "$STORE_ID" ]; then
  STORE_ID=$(vercel blob create-store "$PROJECT" --access private --scope "$SCOPE" </dev/null 2>&1 | grep -o 'store_[A-Za-z0-9]*' | head -1)
  [ -n "$STORE_ID" ] || { echo "Blob store creation failed" >&2; exit 1; }
fi
api -X POST "https://api.vercel.com/v1/storage/stores/$STORE_ID/connections?teamId=$TEAM_ID" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"envVarEnvironments\":[\"production\",\"preview\",\"development\"]}" >/dev/null
echo "Blob store: $STORE_ID (private), connected to the project"

for name in OPENAI_API_KEY OPENAI_VISION_MODEL OPENAI_IMAGE_MODEL OPENAI_IMAGE_QUALITY WARDROBE_IMPORT_SECRET; do
  vercel env rm "$name" production --yes --scope "$SCOPE" >/dev/null 2>&1 || true
  printf '%s' "${!name}" | vercel env add "$name" production --sensitive --scope "$SCOPE" >/dev/null
  echo "Env: $name set for production"
done

vercel env pull .env.local --yes --scope "$SCOPE" >/dev/null
echo "Pulled BLOB_READ_WRITE_TOKEN into .env.local"

npm run publish-data
vercel deploy --prod --yes --scope "$SCOPE"
