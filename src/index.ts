import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { createSupabaseClient } from "./supabase";
import { registerAllTools } from "./tools";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "RumblyAI Assistant",
		version: "1.0.0",
	});

	async init() {
		const supabase = createSupabaseClient(this.env as Env);
		registerAllTools(this.server, supabase);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
