package lan.quick.client;

import lan.quick.net.QuickRequestPayload;
import lan.quick.net.QuickSyncPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;

public class LanQuickClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ClientPlayNetworking.registerGlobalReceiver(QuickSyncPayload.TYPE, (payload, context) -> context.client().execute(() -> QuickMenu.update(payload)));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> QuickMenu.reset());

		ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
			if (!(screen instanceof InventoryScreen inv)) return;
			if (!QuickMenu.known()) return; // vanilla server, or the server does not run the mod
			if (ClientPlayNetworking.canSend(QuickRequestPayload.TYPE)) ClientPlayNetworking.send(QuickRequestPayload.INSTANCE);
			new QuickMenu(client, inv).attach();
		});
	}
}
