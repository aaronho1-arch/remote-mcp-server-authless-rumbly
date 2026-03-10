import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

type ToolResponse = { content: [{ type: "text"; text: string }] };

function ok(text: string): ToolResponse {
	return { content: [{ type: "text", text }] };
}

function err(msg: string): ToolResponse {
	return { content: [{ type: "text", text: `Error: ${msg}` }] };
}

export function registerAllTools(server: McpServer, supabase: SupabaseClient): void {
	// ── get_user_profile ────────────────────────────────────────────────────────
	server.tool(
		"get_user_profile",
		"Get a user's profile including bio and dietary preferences",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const [profileRes, prefsRes] = await Promise.all([
					supabase.from("profiles").select("display_name, email, bio, preferences").eq("id", userId).single(),
					supabase.from("user_preferences").select("dietary_tags, never_ingredients, cuisine_preferences, max_cook_time_minutes").eq("user_id", userId).maybeSingle(),
				]);

				if (profileRes.error) return err(profileRes.error.message);
				if (!profileRes.data) return ok("No profile found for this user.");

				const p = profileRes.data;
				const prefs = prefsRes.data;

				let text = `Profile: ${p.display_name || "Unknown"} (${p.email || "no email"})`;
				if (p.bio) text += `\nBio: ${p.bio}`;

				if (prefs) {
					if (prefs.dietary_tags?.length) text += `\nDietary tags: ${prefs.dietary_tags.join(", ")}`;
					if (prefs.never_ingredients?.length) text += `\nNever use: ${prefs.never_ingredients.join(", ")}`;
					if (prefs.cuisine_preferences?.length) text += `\nCuisine preferences: ${prefs.cuisine_preferences.join(", ")}`;
					if (prefs.max_cook_time_minutes) text += `\nMax cook time: ${prefs.max_cook_time_minutes} minutes`;
				}

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_user_preferences ────────────────────────────────────────────────────
	server.tool(
		"get_user_preferences",
		"Get a user's dietary restrictions, cuisine preferences, and cooking constraints",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const { data, error } = await supabase
					.from("user_preferences")
					.select("dietary_tags, never_ingredients, cuisine_preferences, max_cook_time_minutes")
					.eq("user_id", userId)
					.maybeSingle();

				if (error) return err(error.message);
				if (!data) return ok("No preferences set for this user.");

				let text = "Dietary preferences:";
				if (data.dietary_tags?.length) text += `\n- Tags: ${data.dietary_tags.join(", ")}`;
				if (data.never_ingredients?.length) text += `\n- Never use: ${data.never_ingredients.join(", ")}`;
				if (data.cuisine_preferences?.length) text += `\n- Cuisine preferences: ${data.cuisine_preferences.join(", ")}`;
				if (data.max_cook_time_minutes) text += `\n- Max cook time: ${data.max_cook_time_minutes} minutes`;

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_user_stats ───────────────────────────────────────────────────────────
	server.tool(
		"get_user_stats",
		"Get counts of recipes created, cooked, and liked by a user",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const [createdRes, cookedRes, likedRes, avgRatingRes] = await Promise.all([
					supabase.from("recipes").select("id", { count: "exact", head: true }).eq("user_id", userId),
					supabase.from("cooked_recipes").select("id", { count: "exact", head: true }).eq("user_id", userId),
					supabase.from("recipe_likes").select("recipe_id", { count: "exact", head: true }).eq("user_id", userId),
					supabase.from("cooked_recipes").select("rating").eq("user_id", userId).not("rating", "is", null),
				]);

				const created = createdRes.count ?? 0;
				const cooked = cookedRes.count ?? 0;
				const liked = likedRes.count ?? 0;

				let avgRating = "N/A";
				if (avgRatingRes.data && avgRatingRes.data.length > 0) {
					const sum = avgRatingRes.data.reduce((acc: number, r: { rating: number }) => acc + r.rating, 0);
					avgRating = (sum / avgRatingRes.data.length).toFixed(1) + "/5";
				}

				return ok(
					`User stats:\n- Recipes created: ${created}\n- Recipes cooked: ${cooked}\n- Recipes liked: ${liked}\n- Average rating given: ${avgRating}`,
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_user_recipes ─────────────────────────────────────────────────────────
	server.tool(
		"get_user_recipes",
		"List recipes created by a user",
		{ userId: z.string(), limit: z.number().min(1).max(50).default(10) },
		async ({ userId, limit }) => {
			try {
				const { data, error } = await supabase
					.from("recipes")
					.select("id, title, cuisine, difficulty, cook_time, servings, tags, likes_count, visibility")
					.eq("user_id", userId)
					.order("created_at", { ascending: false })
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("This user has no recipes.");

				const lines = data.map((r, i) => {
					let line = `${i + 1}. ${r.title}`;
					const meta: string[] = [];
					if (r.cuisine) meta.push(r.cuisine);
					if (r.difficulty) meta.push(r.difficulty);
					if (r.cook_time) meta.push(`${r.cook_time} min`);
					if (meta.length) line += ` (${meta.join(", ")})`;
					if (r.tags?.length) line += ` — tags: ${r.tags.join(", ")}`;
					if (r.likes_count) line += ` — ${r.likes_count} likes`;
					if (r.visibility === "private") line += " [private]";
					return line;
				});

				return ok(`${data.length} recipe(s):\n${lines.join("\n")}`);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── search_recipes ───────────────────────────────────────────────────────────
	server.tool(
		"search_recipes",
		"Search public recipes by title or tags",
		{ query: z.string(), limit: z.number().min(1).max(50).default(10) },
		async ({ query, limit }) => {
			try {
				const { data, error } = await supabase
					.from("recipes")
					.select("id, title, cuisine, difficulty, cook_time, tags, likes_count, author_name")
					.eq("visibility", "public")
					.ilike("title", `%${query}%`)
					.order("likes_count", { ascending: false })
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok(`No public recipes found matching "${query}".`);

				const lines = data.map((r, i) => {
					let line = `${i + 1}. ${r.title}`;
					const meta: string[] = [];
					if (r.cuisine) meta.push(r.cuisine);
					if (r.difficulty) meta.push(r.difficulty);
					if (r.cook_time) meta.push(`${r.cook_time} min`);
					if (meta.length) line += ` (${meta.join(", ")})`;
					if (r.author_name) line += ` by ${r.author_name}`;
					if (r.tags?.length) line += ` — tags: ${r.tags.join(", ")}`;
					if (r.likes_count) line += ` — ${r.likes_count} likes`;
					return line;
				});

				return ok(`${data.length} result(s) for "${query}":\n${lines.join("\n")}`);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_recipe_detail ────────────────────────────────────────────────────────
	server.tool(
		"get_recipe_detail",
		"Get full details of a recipe including ingredients and steps",
		{ recipeId: z.string() },
		async ({ recipeId }) => {
			try {
				const { data, error } = await supabase
					.from("recipes")
					.select("title, description, cuisine, difficulty, cook_time, servings, calories, tags, ingredients, steps, source_url")
					.eq("id", recipeId)
					.single();

				if (error) return err(error.message);
				if (!data) return ok("Recipe not found.");

				const meta: string[] = [];
				if (data.cuisine) meta.push(`Cuisine: ${data.cuisine}`);
				if (data.difficulty) meta.push(`Difficulty: ${data.difficulty}`);
				if (data.cook_time) meta.push(`Cook time: ${data.cook_time} min`);
				if (data.servings) meta.push(`Servings: ${data.servings}`);
				if (data.calories) meta.push(`Calories: ${data.calories}`);

				let text = `Title: ${data.title}`;
				if (meta.length) text += `\n${meta.join(" | ")}`;
				if (data.tags?.length) text += `\nTags: ${data.tags.join(", ")}`;
				if (data.description) text += `\n\n${data.description}`;

				if (data.ingredients?.length) {
					text += "\n\nIngredients:";
					for (const ing of data.ingredients) {
						const parts = [ing.quantity, ing.unit, ing.name].filter(Boolean);
						text += `\n- ${parts.join(" ")}`;
					}
				}

				if (data.steps?.length) {
					text += "\n\nSteps:";
					data.steps.forEach((step: string, i: number) => {
						text += `\n${i + 1}. ${step}`;
					});
				}

				if (data.source_url) text += `\n\nSource: ${data.source_url}`;

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_favorite_recipes ─────────────────────────────────────────────────────
	server.tool(
		"get_favorite_recipes",
		"Get recipes that a user has liked/favorited",
		{ userId: z.string(), limit: z.number().min(1).max(50).default(10) },
		async ({ userId, limit }) => {
			try {
				const { data, error } = await supabase
					.from("recipe_likes")
					.select("recipes(id, title, cuisine, difficulty, cook_time, tags, likes_count)")
					.eq("user_id", userId)
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("This user has no favorited recipes.");

				const lines = data.map((row, i) => {
					const r = row.recipes as unknown as { id: string; title: string; cuisine: string; difficulty: string; cook_time: number; tags: string[]; likes_count: number } | null;
					if (!r) return `${i + 1}. (recipe not found)`;
					let line = `${i + 1}. ${r.title}`;
					const meta: string[] = [];
					if (r.cuisine) meta.push(r.cuisine);
					if (r.difficulty) meta.push(r.difficulty);
					if (r.cook_time) meta.push(`${r.cook_time} min`);
					if (meta.length) line += ` (${meta.join(", ")})`;
					if (r.tags?.length) line += ` — tags: ${r.tags.join(", ")}`;
					return line;
				});

				return ok(`${data.length} favorite recipe(s):\n${lines.join("\n")}`);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_pantry_items ─────────────────────────────────────────────────────────
	server.tool(
		"get_pantry_items",
		"Get a user's pantry/fridge contents, optionally filtered by category",
		{ userId: z.string(), category: z.string().optional() },
		async ({ userId, category }) => {
			try {
				let query = supabase
					.from("pantry_items")
					.select("name, quantity, unit, category, expiry_date")
					.eq("user_id", userId)
					.order("category")
					.order("name");

				if (category) query = query.ilike("category", category);

				const { data, error } = await query;

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("Pantry is empty.");

				const now = new Date();
				const soon = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

				// Group by category
				const byCategory: Record<string, string[]> = {};
				for (const item of data) {
					const cat = item.category || "Uncategorized";
					if (!byCategory[cat]) byCategory[cat] = [];
					let line = `${item.quantity ?? ""} ${item.unit ?? ""} ${item.name}`.trim();
					if (item.expiry_date) {
						const exp = new Date(item.expiry_date);
						if (exp <= soon) line += ` ⚠ expires ${item.expiry_date}`;
						else line += ` (expires ${item.expiry_date})`;
					}
					byCategory[cat].push(line);
				}

				const lines: string[] = [`Pantry (${data.length} items):`];
				for (const [cat, items] of Object.entries(byCategory)) {
					lines.push(`${cat}: ${items.join(", ")}`);
				}

				return ok(lines.join("\n"));
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_shopping_list ────────────────────────────────────────────────────────
	server.tool(
		"get_shopping_list",
		"Get a user's current shopping list",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const { data, error } = await supabase
					.from("shopping_list")
					.select("name, quantity, unit, category, is_checked")
					.eq("user_id", userId)
					.order("is_checked")
					.order("category")
					.order("name");

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("Shopping list is empty.");

				const needed = data.filter((i) => !i.is_checked);
				const checked = data.filter((i) => i.is_checked);

				const fmt = (item: { name: string; quantity: number | null; unit: string | null; category: string | null }) => {
					let line = item.name;
					if (item.quantity) line = `${item.quantity} ${item.unit ?? ""} ${line}`.trim();
					if (item.category) line += ` (${item.category})`;
					return line;
				};

				let text = `Shopping list (${data.length} items, ${checked.length} checked):`;
				if (needed.length) {
					text += "\nStill needed:";
					needed.forEach((i) => (text += `\n- [ ] ${fmt(i)}`));
				}
				if (checked.length) {
					text += "\nAlready have:";
					checked.forEach((i) => (text += `\n- [x] ${fmt(i)}`));
				}

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_cooking_history ──────────────────────────────────────────────────────
	server.tool(
		"get_cooking_history",
		"Get a user's cooking history with ratings",
		{ userId: z.string(), limit: z.number().min(1).max(50).default(10) },
		async ({ userId, limit }) => {
			try {
				const { data, error } = await supabase
					.from("cooked_recipes")
					.select("cooked_at, rating, notes, recipes(title)")
					.eq("user_id", userId)
					.order("cooked_at", { ascending: false })
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("No cooking history found.");

				const lines = data.map((row, i) => {
					const title = (row.recipes as unknown as { title: string } | null)?.title ?? "Unknown recipe";
					const date = row.cooked_at ? new Date(row.cooked_at).toLocaleDateString() : "unknown date";
					let line = `${i + 1}. ${title} — cooked ${date}`;
					if (row.rating) line += ` — rating: ${row.rating}/5`;
					if (row.notes) line += ` — "${row.notes}"`;
					return line;
				});

				return ok(`Cooking history (last ${data.length}):\n${lines.join("\n")}`);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_meal_plan ────────────────────────────────────────────────────────────
	server.tool(
		"get_meal_plan",
		"Get a user's current meal plan for the week",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const { data: plan, error: planError } = await supabase
					.from("meal_plans")
					.select("id, week_start")
					.eq("user_id", userId)
					.order("week_start", { ascending: false })
					.limit(1)
					.maybeSingle();

				if (planError) return err(planError.message);
				if (!plan) return ok("No meal plan found.");

				const { data: slots, error: slotsError } = await supabase
					.from("meal_plan_slots")
					.select("planned_date, day_label, recipes(title, cook_time)")
					.eq("plan_id", plan.id)
					.order("planned_date");

				if (slotsError) return err(slotsError.message);

				let text = `Meal plan for week of ${plan.week_start}:`;
				if (!slots || slots.length === 0) {
					text += "\n(no meals planned)";
				} else {
					for (const slot of slots) {
						const recipe = slot.recipes as unknown as { title: string; cook_time: number | null } | null;
						const day = slot.day_label || slot.planned_date;
						if (recipe) {
							text += `\n${day}: ${recipe.title}`;
							if (recipe.cook_time) text += ` (${recipe.cook_time} min)`;
						} else {
							text += `\n${day}: (not planned)`;
						}
					}
				}

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);
}
