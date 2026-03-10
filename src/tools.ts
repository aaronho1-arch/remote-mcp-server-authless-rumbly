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
		"Get a user's profile including bio, dietary preferences, and allergies",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const [profileRes, prefsRes] = await Promise.all([
					supabase
						.from("profiles")
						.select("display_name, email, bio, preferences, settings")
						.eq("id", userId)
						.single(),
					supabase
						.from("user_preferences")
						.select("dietary_tags, never_ingredients, cuisine_preferences, max_cook_time_minutes")
						.eq("user_id", userId)
						.maybeSingle(),
				]);

				if (profileRes.error) return err(profileRes.error.message);
				if (!profileRes.data) return ok("No profile found for this user.");

				const p = profileRes.data;
				const prefs = prefsRes.data;

				// profiles.preferences is JSONB: { dietary: string[], allergies: string[] }
				const profilePrefs = p.preferences as { dietary?: string[]; allergies?: string[] } | null;
				// profiles.settings is JSONB: { notifications: boolean, measurementSystem: string }
				const settings = p.settings as { measurementSystem?: string } | null;

				let text = `Profile: ${p.display_name || "Unknown"} (${p.email || "no email"})`;
				if (p.bio) text += `\nBio: ${p.bio}`;
				if (settings?.measurementSystem) text += `\nMeasurement system: ${settings.measurementSystem}`;

				// Allergies from profiles.preferences
				if (profilePrefs?.allergies?.length) text += `\nAllergies: ${profilePrefs.allergies.join(", ")}`;

				// Detailed prefs from user_preferences table
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
					.select("id, title, cuisine, difficulty, cook_time, servings, tags, likes_count, visibility, is_imported")
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
					if (r.is_imported) line += " [imported]";
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
					.select(
						"title, description, cuisine, difficulty, cook_time, servings, calories, tags, ingredients, steps, source_url, is_imported, author_name",
					)
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
				if (data.author_name) text += ` by ${data.author_name}`;
				if (meta.length) text += `\n${meta.join(" | ")}`;
				if (data.tags?.length) text += `\nTags: ${data.tags.join(", ")}`;
				if (data.is_imported && data.source_url) text += `\nImported from: ${data.source_url}`;
				if (data.description) text += `\n\n${data.description}`;

				// Ingredients: { name, quantity, unit, image_url }
				if (data.ingredients?.length) {
					text += "\n\nIngredients:";
					for (const ing of data.ingredients as { name?: string; quantity?: string | number; unit?: string }[]) {
						const parts = [ing.quantity, ing.unit, ing.name].filter(Boolean);
						text += `\n- ${parts.join(" ")}`;
					}
				}

				// Steps: can be strings OR { order, instruction, imageUrl } objects
				if (data.steps?.length) {
					text += "\n\nSteps:";
					(data.steps as (string | { instruction?: string; order?: number })[]).forEach((step, i) => {
						const instruction = typeof step === "string" ? step : (step.instruction ?? "");
						text += `\n${i + 1}. ${instruction}`;
					});
				}

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
					.select("recipes(id, title, cuisine, difficulty, cook_time, tags, likes_count, author_name)")
					.eq("user_id", userId)
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("This user has no favorited recipes.");

				const lines = data.map((row, i) => {
					const r = row.recipes as unknown as {
						id: string;
						title: string;
						cuisine: string;
						difficulty: string;
						cook_time: number;
						tags: string[];
						likes_count: number;
						author_name: string;
					} | null;
					if (!r) return `${i + 1}. (recipe not found)`;
					let line = `${i + 1}. ${r.title}`;
					if (r.author_name) line += ` by ${r.author_name}`;
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
					.select("name, quantity, unit, category, expiry_date, added_at")
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
		"Get a user's standalone shopping list (manually added items)",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				const { data, error } = await supabase
					.from("shopping_list")
					.select("name, quantity, unit, category, is_checked, recipe_names")
					.eq("user_id", userId)
					.order("is_checked")
					.order("category")
					.order("name");

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("Shopping list is empty.");

				const needed = data.filter((i) => !i.is_checked);
				const checked = data.filter((i) => i.is_checked);

				const fmt = (item: { name: string; quantity: number | null; unit: string | null; category: string | null; recipe_names?: string[] | null }) => {
					let line = item.name;
					if (item.quantity) line = `${item.quantity} ${item.unit ?? ""} ${line}`.trim();
					if (item.category) line += ` (${item.category})`;
					if (item.recipe_names?.length) line += ` [for: ${item.recipe_names.join(", ")}]`;
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
		"Get a user's cooking history with ratings and notes",
		{ userId: z.string(), limit: z.number().min(1).max(50).default(10) },
		async ({ userId, limit }) => {
			try {
				const { data, error } = await supabase
					.from("cooked_recipes")
					.select("cooked_at, rating, notes, recipes(title, cuisine, difficulty)")
					.eq("user_id", userId)
					.order("cooked_at", { ascending: false })
					.limit(limit);

				if (error) return err(error.message);
				if (!data || data.length === 0) return ok("No cooking history found.");

				const lines = data.map((row, i) => {
					const recipe = row.recipes as unknown as { title: string; cuisine: string | null; difficulty: string | null } | null;
					const title = recipe?.title ?? "Unknown recipe";
					const date = row.cooked_at ? new Date(row.cooked_at).toLocaleDateString() : "unknown date";
					let line = `${i + 1}. ${title} — cooked ${date}`;
					if (recipe?.cuisine) line += ` (${recipe.cuisine})`;
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
		"Get a user's current meal plan for the week, organised by day and meal type",
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
					.select("planned_date, day_label, meal_type, is_locked, is_busy_night, recipes(title, cook_time, difficulty)")
					.eq("plan_id", plan.id)
					.order("planned_date")
					.order("slot_order");

				if (slotsError) return err(slotsError.message);

				let text = `Meal plan for week of ${plan.week_start}:`;

				if (!slots || slots.length === 0) {
					text += "\n(no meals planned)";
				} else {
					// Group by day
					const byDay: Record<string, typeof slots> = {};
					for (const slot of slots) {
						const key = slot.day_label || slot.planned_date;
						if (!byDay[key]) byDay[key] = [];
						byDay[key].push(slot);
					}

					for (const [day, daySlots] of Object.entries(byDay)) {
						const busyNight = daySlots.some((s) => s.is_busy_night);
						text += `\n${day}:${busyNight ? " [busy night]" : ""}`;
						for (const slot of daySlots) {
							const recipe = slot.recipes as unknown as { title: string; cook_time: number | null; difficulty: string | null } | null;
							const mealLabel = slot.meal_type ? `  ${slot.meal_type.charAt(0).toUpperCase() + slot.meal_type.slice(1)}` : "  Meal";
							if (recipe) {
								let entry = `${mealLabel}: ${recipe.title}`;
								const meta: string[] = [];
								if (recipe.cook_time) meta.push(`${recipe.cook_time} min`);
								if (recipe.difficulty) meta.push(recipe.difficulty);
								if (meta.length) entry += ` (${meta.join(", ")})`;
								if (slot.is_locked) entry += " 🔒";
								text += `\n${entry}`;
							} else {
								text += `\n${mealLabel}: (not planned)`;
							}
						}
					}
				}

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);

	// ── get_grocery_list ─────────────────────────────────────────────────────────
	server.tool(
		"get_grocery_list",
		"Get the generated grocery list for a user's current meal plan",
		{ userId: z.string() },
		async ({ userId }) => {
			try {
				// Find most recent meal plan
				const { data: plan, error: planError } = await supabase
					.from("meal_plans")
					.select("id, week_start")
					.eq("user_id", userId)
					.order("week_start", { ascending: false })
					.limit(1)
					.maybeSingle();

				if (planError) return err(planError.message);
				if (!plan) return ok("No meal plan found.");

				// Find the grocery list for that plan
				const { data: groceryList, error: listError } = await supabase
					.from("grocery_lists")
					.select("id")
					.eq("plan_id", plan.id)
					.eq("user_id", userId)
					.maybeSingle();

				if (listError) return err(listError.message);
				if (!groceryList) return ok(`No grocery list generated for meal plan (week of ${plan.week_start}). Generate it in the app first.`);

				// Get items (exclude archived)
				const { data: items, error: itemsError } = await supabase
					.from("grocery_items")
					.select("name, quantity, unit, category, is_checked, is_custom")
					.eq("list_id", groceryList.id)
					.eq("is_archived", false)
					.order("category")
					.order("name");

				if (itemsError) return err(itemsError.message);
				if (!items || items.length === 0) return ok("Grocery list is empty.");

				const needed = items.filter((i) => !i.is_checked);
				const checked = items.filter((i) => i.is_checked);

				const fmt = (item: { name: string; quantity: number | null; unit: string | null; is_custom: boolean }) => {
					let line = item.name;
					if (item.quantity) line = `${item.quantity} ${item.unit ?? ""} ${line}`.trim();
					if (item.is_custom) line += " [custom]";
					return line;
				};

				// Group needed items by category
				const byCategory: Record<string, string[]> = {};
				for (const item of needed) {
					const cat = item.category || "Other";
					if (!byCategory[cat]) byCategory[cat] = [];
					byCategory[cat].push(`[ ] ${fmt(item)}`);
				}

				let text = `Grocery list for meal plan (week of ${plan.week_start}) — ${items.length} items, ${checked.length} checked:`;

				if (needed.length) {
					text += "\n\nStill needed:";
					for (const [cat, catItems] of Object.entries(byCategory)) {
						text += `\n${cat}:`;
						catItems.forEach((line) => (text += `\n  - ${line}`));
					}
				}

				if (checked.length) {
					text += `\n\nAlready got (${checked.length}): ${checked.map((i) => i.name).join(", ")}`;
				}

				return ok(text);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	);
}
