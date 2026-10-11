package lan.quick;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.GlobalPos;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.core.registries.BuiltInRegistries;
import java.util.ArrayList;
import java.util.Comparator;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Set;

/** /quick ... — everything the menu buttons send. Works typed by hand too. */
public class QuickCommands {

	public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		LiteralArgumentBuilder<CommandSourceStack> quick = Commands.literal("quick").requires(LanQuick::canUse);

		quick.then(Commands.literal("places").executes(QuickCommands::listPlaces));
		quick.then(Commands.literal("tp")
			.then(Commands.argument("position", Vec3Argument.vec3()).executes(c -> tpTo(c, Vec3Argument.getVec3(c, "position"))))
			.then(Commands.argument("place", StringArgumentType.greedyString()).suggests(QuickCommands::suggestPlaces).executes(QuickCommands::tpPlace)));
		quick.then(Commands.literal("day").executes(c -> vanilla(c, "time set day", "It is day.")));
		quick.then(Commands.literal("night").executes(c -> vanilla(c, "time set night", "It is night.")));
		quick.then(Commands.literal("clear").executes(c -> vanilla(c, "weather clear", "The sky is clear.")));
		quick.then(Commands.literal("rain").executes(c -> vanilla(c, "weather rain", "Rain.")));
		quick.then(Commands.literal("bring")
			.then(Commands.argument("animal", StringArgumentType.word()).suggests(QuickCommands::suggestAnimals)
				.executes(c -> bring(c, StringArgumentType.getString(c, "animal"), 1))
				.then(Commands.argument("count", IntegerArgumentType.integer(0, 64)).executes(c -> bring(c, StringArgumentType.getString(c, "animal"), IntegerArgumentType.getInteger(c, "count"))))));
		quick.then(Commands.literal("back").executes(QuickCommands::back));
		quick.then(Commands.literal("spawn").executes(QuickCommands::spawn));
		quick.then(Commands.literal("home").executes(QuickCommands::home));
		quick.then(Commands.literal("sethome").executes(QuickCommands::setHome));
		quick.then(Commands.literal("mark").then(Commands.argument("name", StringArgumentType.greedyString()).executes(QuickCommands::mark)));
		quick.then(Commands.literal("keepinv").executes(QuickCommands::keepInventory));
		quick.then(Commands.literal("coords").executes(QuickCommands::coords));
		quick.then(Commands.literal("reload").requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS)).executes(c -> {
			LanQuick.reload();
			LanQuick.places.refresh(LanQuick::runOnServer, LanQuick::syncAll);
			LanQuick.syncAll();
			c.getSource().sendSuccess(() -> Component.literal("Quick menu config and places reloaded."), false);
			return 1;
		}));

		dispatcher.register(quick);
	}

	// ---------- places ----------

	private static java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> suggestPlaces(CommandContext<CommandSourceStack> c, com.mojang.brigadier.suggestion.SuggestionsBuilder b) {
		return SharedSuggestionProvider.suggest(LanQuick.places.all().stream().map(Place::title), b);
	}

	private static int listPlaces(CommandContext<CommandSourceStack> c) {
		List<Place> all = LanQuick.places.all();
		if (all.isEmpty()) {
			c.getSource().sendSuccess(() -> Component.literal("No places yet. Add some on the site's Places tab or with /quick mark <name>."), false);
			return 0;
		}
		for (Place p : all) {
			c.getSource().sendSuccess(() -> Component.literal(String.format("%s  (%s)  %d %d %d%s", p.title(), p.type().isEmpty() ? "place" : p.type(), p.x(), p.y(), p.z(), p.dim().equals("overworld") ? "" : "  " + p.dim())), false);
		}
		return all.size();
	}

	private static int tpPlace(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		String name = StringArgumentType.getString(c, "place");
		Place p = LanQuick.places.find(name);
		if (p == null) {
			c.getSource().sendFailure(Component.literal("No place called \"" + name + "\". /quick places lists them."));
			return 0;
		}
		ServerPlayer player = c.getSource().getPlayerOrException();
		ServerLevel level = levelFor(c.getSource().getServer(), p.dim(), player.level());
		teleport(player, level, p.x() + 0.5, p.y(), p.z() + 0.5);
		c.getSource().sendSuccess(() -> Component.literal("Teleported to " + p.title() + "."), false);
		return 1;
	}

	private static int tpTo(CommandContext<CommandSourceStack> c, Vec3 pos) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		teleport(player, player.level(), pos.x, pos.y, pos.z);
		c.getSource().sendSuccess(() -> Component.literal(String.format("Teleported to %d %d %d.", (int) Math.floor(pos.x), (int) Math.floor(pos.y), (int) Math.floor(pos.z))), false);
		return 1;
	}

	/** Lands on the first free spot at or above y, so a place marked at ground level does not put you inside a block. */
	private static void teleport(ServerPlayer player, ServerLevel level, double x, double y, double z) {
		double ty = y;
		BlockPos bp = BlockPos.containing(x, y, z);
		for (int i = 0; i < 8; i++) {
			BlockPos feet = bp.above(i);
			if (level.getBlockState(feet).getCollisionShape(level, feet).isEmpty() && level.getBlockState(feet.above()).getCollisionShape(level, feet.above()).isEmpty()) {
				ty = feet.getY();
				break;
			}
		}
		player.teleportTo(level, x, ty, z, Set.of(), player.getYRot(), player.getXRot(), true);
	}

	private static ServerLevel levelFor(MinecraftServer server, String dim, ServerLevel fallback) {
		if (dim == null || dim.isEmpty() || dim.equals("overworld")) return server.overworld();
		ServerLevel l = server.getLevel(ResourceKey.create(Registries.DIMENSION, Identifier.withDefaultNamespace(dim)));
		return l != null ? l : fallback;
	}

	// ---------- vanilla commands run by the server, so nobody needs op ----------

	private static int vanilla(CommandContext<CommandSourceStack> c, String command, String feedback) {
		MinecraftServer server = c.getSource().getServer();
		server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSuppressedOutput(), command);
		Component msg = Component.literal(feedback + "  (" + c.getSource().getTextName() + ")");
		for (ServerPlayer p : server.getPlayerList().getPlayers()) p.sendSystemMessage(msg, true);
		return 1;
	}

	private static int keepInventory(CommandContext<CommandSourceStack> c) {
		ServerLevel level = c.getSource().getLevel();
		boolean now = !level.getGameRules().get(GameRules.KEEP_INVENTORY);
		level.getGameRules().set(GameRules.KEEP_INVENTORY, now, c.getSource().getServer());
		Component msg = Component.literal("Keep inventory is now " + (now ? "ON" : "OFF") + "  (" + c.getSource().getTextName() + ")");
		for (ServerPlayer p : c.getSource().getServer().getPlayerList().getPlayers()) p.sendSystemMessage(msg, false);
		return now ? 1 : 0;
	}

	// ---------- animals: bring the nearest of a kind to me ----------

	private static java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> suggestAnimals(CommandContext<CommandSourceStack> c, com.mojang.brigadier.suggestion.SuggestionsBuilder b) {
		return SharedSuggestionProvider.suggest(Animals.ALL.stream().map(Animals.Kind::id), b);
	}

	/**
	 * /quick bring panda      -> the nearest panda comes to you
	 * /quick bring cow 5      -> the five nearest cows
	 * /quick bring wolf 0     -> every wolf within Animals.ALL_RADIUS blocks
	 */
	private static int bring(CommandContext<CommandSourceStack> c, String id, int count) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		Animals.Kind kind = Animals.find(id);
		Identifier typeId = Identifier.withDefaultNamespace(kind != null ? kind.id() : id.toLowerCase());
		var type = BuiltInRegistries.ENTITY_TYPE.getOptional(typeId);
		if (type.isEmpty()) {
			c.getSource().sendFailure(Component.literal("No creature called \"" + id + "\"."));
			return 0;
		}
		ServerLevel level = player.level();
		int radius = count == 0 ? Animals.ALL_RADIUS : Animals.SEARCH_RADIUS;
		double r2 = (double) radius * radius;
		List<? extends Mob> found = level.getEntities(EntityTypeTest.forClass(Mob.class), m -> m.getType() == type.get() && m.isAlive() && m.distanceToSqr(player) <= r2);
		List<Mob> sorted = new ArrayList<>(found);
		sorted.sort(Comparator.comparingDouble(m -> m.distanceToSqr(player)));
		int wanted = count == 0 ? sorted.size() : Math.min(count, sorted.size());
		Vec3 at = player.position();
		int n = 0;
		for (Mob m : sorted.subList(0, wanted)) {
			double a = n * 2.39996; // golden angle: spread them in a loose spiral around the player
			double d = 1.5 + 0.4 * n;
			m.teleportTo(level, at.x + Math.cos(a) * d, at.y, at.z + Math.sin(a) * d, Set.of(), m.getYRot(), m.getXRot(), false);
			n++;
		}
		String name = kind != null ? kind.label() : type.get().getDescription().getString();
		if (n == 0) {
			c.getSource().sendFailure(Component.literal("No " + name.toLowerCase() + " within " + radius + " blocks."));
			return 0;
		}
		int moved = n;
		c.getSource().sendSuccess(() -> Component.literal(moved == 1 ? name + " is here." : moved + " x " + name.toLowerCase() + " are here."), false);
		return moved;
	}

	// ---------- me ----------

	private static int back(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		var death = player.getLastDeathLocation();
		if (death.isEmpty()) {
			c.getSource().sendFailure(Component.literal("No death recorded yet."));
			return 0;
		}
		GlobalPos gp = death.get();
		ServerLevel level = c.getSource().getServer().getLevel(gp.dimension());
		if (level == null) level = player.level();
		BlockPos pos = gp.pos();
		teleport(player, level, pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5);
		c.getSource().sendSuccess(() -> Component.literal("Back where you died. Grab your stuff."), false);
		return 1;
	}

	private static int spawn(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		ServerLevel overworld = c.getSource().getServer().overworld();
		BlockPos pos = overworld.getRespawnData().pos();
		teleport(player, overworld, pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5);
		c.getSource().sendSuccess(() -> Component.literal("At spawn."), false);
		return 1;
	}

	private static int home(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		PlayerData.Pos h = LanQuick.players.home(player.getUUID());
		if (h == null) {
			c.getSource().sendFailure(Component.literal("No home set. Stand where you want it and use /quick sethome."));
			return 0;
		}
		ServerLevel level = levelFor(c.getSource().getServer(), h.dim(), player.level());
		player.teleportTo(level, h.x(), h.y(), h.z(), Set.of(), h.yaw(), h.pitch(), true);
		c.getSource().sendSuccess(() -> Component.literal("Home."), false);
		return 1;
	}

	private static int setHome(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		Vec3 p = player.position();
		LanQuick.players.setHome(player.getUUID(), new PlayerData.Pos(dimName(player.level()), p.x, p.y, p.z, player.getYRot(), player.getXRot()));
		c.getSource().sendSuccess(() -> Component.literal(String.format("Home set at %d %d %d.", (int) Math.floor(p.x), (int) Math.floor(p.y), (int) Math.floor(p.z))), false);
		LanQuick.sync(player);
		return 1;
	}

	private static int mark(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		String name = StringArgumentType.getString(c, "name").trim();
		if (name.isEmpty()) {
			c.getSource().sendFailure(Component.literal("Give the place a name: /quick mark Cow farm"));
			return 0;
		}
		BlockPos bp = player.blockPosition();
		Place place = new Place(name, Place.guessType(name), bp.getX(), bp.getY(), bp.getZ(), dimName(player.level()));
		CommandSourceStack source = c.getSource();
		LanQuick.places.mark(place, player.getScoreboardName(), LanQuick::runOnServer, error -> {
			if (error != null) {
				source.sendFailure(Component.literal("Could not save the place: " + error));
				return;
			}
			source.sendSuccess(() -> Component.literal(String.format("Marked \"%s\" (%s) at %d %d %d%s.", name, place.type(), bp.getX(), bp.getY(), bp.getZ(), LanQuick.places.hasSite() ? ", it is on the site's Places tab" : "")), true);
			LanQuick.places.forceChanged();
			LanQuick.places.refresh(LanQuick::runOnServer, LanQuick::syncAll);
			LanQuick.syncAll();
		});
		return 1;
	}

	private static int coords(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		BlockPos bp = player.blockPosition();
		String dim = dimName(player.level());
		Component msg = Component.literal(String.format("%s is at %d %d %d%s", player.getScoreboardName(), bp.getX(), bp.getY(), bp.getZ(), dim.equals("overworld") ? "" : " in " + dim));
		for (ServerPlayer p : c.getSource().getServer().getPlayerList().getPlayers()) p.sendSystemMessage(msg, false);
		return 1;
	}

	static String dimName(Level level) {
		ResourceKey<Level> key = level.dimension();
		if (key == Level.NETHER) return "the_nether";
		if (key == Level.END) return "the_end";
		return "overworld";
	}
}
