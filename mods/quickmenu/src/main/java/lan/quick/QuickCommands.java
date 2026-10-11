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
import net.minecraft.world.entity.animal.Animal;
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
		quick.then(Commands.literal("animals")
			.then(Commands.literal("place").then(Commands.argument("place", StringArgumentType.greedyString()).suggests(QuickCommands::suggestPlaces).executes(QuickCommands::animalsToPlace)))
			.then(Commands.argument("position", Vec3Argument.vec3())
				.executes(c -> animals(c, Vec3Argument.getVec3(c, "position"), LanQuick.config.animalsRadius))
				.then(Commands.argument("radius", IntegerArgumentType.integer(1, 128)).executes(c -> animals(c, Vec3Argument.getVec3(c, "position"), IntegerArgumentType.getInteger(c, "radius"))))));
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

	// ---------- animals ----------

	private static int animalsToPlace(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
		String name = StringArgumentType.getString(c, "place");
		Place p = LanQuick.places.find(name);
		if (p == null) {
			c.getSource().sendFailure(Component.literal("No place called \"" + name + "\"."));
			return 0;
		}
		return animals(c, new Vec3(p.x() + 0.5, p.y(), p.z() + 0.5), LanQuick.config.animalsRadius);
	}

	/** Every animal within radius blocks of you goes to the target, spread out a little. Same dimension only. */
	private static int animals(CommandContext<CommandSourceStack> c, Vec3 target, int radius) throws CommandSyntaxException {
		ServerPlayer player = c.getSource().getPlayerOrException();
		ServerLevel level = player.level();
		double r2 = (double) radius * radius;
		List<? extends Animal> found = level.getEntities(EntityTypeTest.forClass(Animal.class), a -> a.isAlive() && a.distanceToSqr(player) <= r2);
		int n = 0;
		for (Animal a : found) {
			double ox = ((n % 3) - 1) * 1.5, oz = (((n / 3) % 3) - 1) * 1.5;
			a.teleportTo(level, target.x + ox, target.y, target.z + oz, Set.of(), a.getYRot(), a.getXRot(), false);
			n++;
		}
		int count = n;
		if (count == 0) c.getSource().sendFailure(Component.literal("No animals within " + radius + " blocks of you."));
		else c.getSource().sendSuccess(() -> Component.literal(String.format("Moved %d animal%s to %d %d %d.", count, count == 1 ? "" : "s", (int) Math.floor(target.x), (int) Math.floor(target.y), (int) Math.floor(target.z))), false);
		return count;
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
