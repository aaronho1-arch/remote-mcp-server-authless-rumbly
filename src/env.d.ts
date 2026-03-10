// Augments the auto-generated Env interface with secrets set via `wrangler secret put`
// (these don't appear in worker-configuration.d.ts)
interface Env {
	SUPABASE_SERVICE_ROLE_KEY: string;
}
