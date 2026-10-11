package lan.quick;

import lan.quick.net.QuickRequestPayload;
import lan.quick.net.QuickSyncPayload;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class LanQuick implements ModInitializer {
	public static final String MOD_ID = "lanquick";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	public static QuickConfig config;
	public static Places places;
	public static PlayerData players;
	private static MinecraftServer server;
	private static int ticks = 0;

	@Override
	public void onInitialize() {
		PayloadTypeRegistry.clientboundPlay().register(QuickSyncPayload.TYPE, QuickSyncPayload.CODEC);
		PayloadTypeRegistry.serverboundPlay().register(QuickRequestPayload.TYPE, QuickRequestPayload.CODEC);

		reload();

		ServerLifecycleEvents.SERVER_STARTED.register(s -> {
			server = s;
			places.refresh(LanQuick::runOnServer, LanQuick::syncAll);
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> server = null);

		ServerTickEvents.END_SERVER_TICK.register(s -> {
			int every = Math.max(10, config.placesRefreshSeconds) * 20;
			if (++ticks % every == 0) places.refresh(LanQuick::runOnServer, LanQuick::syncAll);
		});

		ServerPlayConnectionEvents.JOIN.register((handler, sender, s) -> sync(handler.player));
		ServerPlayNetworking.registerGlobalReceiver(QuickRequestPayload.TYPE, (payload, context) -> sync(context.player()));

		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> QuickCommands.register(dispatcher));
		LOGGER.info("LAN Quick Menu ready ({} places, site {})", places.all().size(), places.hasSite() ? config.siteBase() : "none");
	}

	public static void reload() {
		var dir = FabricLoader.getInstance().getConfigDir();
		config = QuickConfig.load(dir);
		places = new Places(config, dir);
		players = new PlayerData(dir);
	}

	public static void runOnServer(Runnable r) {
		MinecraftServer s = server;
		if (s != null) s.execute(r);
	}

	public static boolean canUse(CommandSourceStack source) {
		return config.everyoneCanUse || Commands.hasPermission(Commands.LEVEL_GAMEMASTERS).test(source);
	}

	public static void syncAll() {
		MinecraftServer s = server;
		if (s == null) return;
		for (ServerPlayer p : s.getPlayerList().getPlayers()) sync(p);
	}

	public static void sync(ServerPlayer player) {
		if (!ServerPlayNetworking.canSend(player, QuickSyncPayload.TYPE)) return;
		boolean canUse = canUse(player.createCommandSourceStack());
		ServerPlayNetworking.send(player, new QuickSyncPayload(
			places.all(), canUse, players.home(player.getUUID()) != null, player.getLastDeathLocation().isPresent(),
			config.animalsRadius, config.boatSpeeds));
	}
}
