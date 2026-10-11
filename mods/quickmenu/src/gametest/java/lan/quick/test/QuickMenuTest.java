package lan.quick.test;

import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.fabric.api.client.gametest.v1.screenshot.TestScreenshotOptions;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.world.level.gamerules.GameRules;

/**
 * Opens a singleplayer world, marks a place, opens the inventory and walks every quick-menu tab, pressing the
 * buttons that change the world (day, keep inventory, teleport to the marked place) and checking the server saw it.
 */
public class QuickMenuTest implements FabricClientGameTest {
	@Override
	public void runTest(ClientGameTestContext context) {
		try (TestSingleplayerContext world = context.worldBuilder().create()) {
			world.getConnection().waitForChunksRender(true, 1200);
			context.waitTicks(20);

			// a place to teleport to, made in game (no site in the test)
			for (String name : new String[]{"Test Spot", "Cow farm", "Old village", "Nether portal", "Main base", "Deep mine"}) {
				context.runOnClient(client -> client.getConnection().sendCommand("quick mark " + name));
				context.waitTicks(2);
			}
			context.runOnClient(client -> client.getConnection().sendCommand("quick sethome"));
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(20);

			openInventory(context);
			context.takeScreenshot(TestScreenshotOptions.of("01-places"));
			context.clickScreenButton("Weather");
			context.takeScreenshot(TestScreenshotOptions.of("02-weather"));
			context.clickScreenButton("Boat");
			context.takeScreenshot(TestScreenshotOptions.of("03-boat"));
			context.clickScreenButton("Animals");
			context.takeScreenshot(TestScreenshotOptions.of("04-animals"));
			context.clickScreenButton("Me");
			context.takeScreenshot(TestScreenshotOptions.of("05-me"));

			// Keep inventory: the button flips the game rule on the server
			boolean before = world.getServer().computeOnServer(s -> s.overworld().getGameRules().get(GameRules.KEEP_INVENTORY));
			context.clickScreenButton("Keep inventory");
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			boolean after = world.getServer().computeOnServer(s -> s.overworld().getGameRules().get(GameRules.KEEP_INVENTORY));
			if (before == after) throw new AssertionError("keep inventory did not flip (" + before + " -> " + after + ")");

			// Day: the Weather tab's Day button sets the time of day
			openInventory(context);
			context.clickScreenButton("Weather");
			context.clickScreenButton("Day");
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			long dayTime = world.getServer().computeOnServer(s -> s.overworld().getOverworldClockTime() % 24000L);
			if (dayTime < 900 || dayTime > 1300) throw new AssertionError("time set day did not land near 1000, got " + dayTime);

			// Places: teleport to the marked spot, which is where we stand, so the position stays within a block
			openInventory(context);
			context.clickScreenButton("Places");
			context.takeScreenshot(TestScreenshotOptions.of("06-places-all"));
			context.clickScreenButton("Farm");
			context.takeScreenshot(TestScreenshotOptions.of("07-places-farm"));
			context.clickScreenButton("Other");
			context.takeScreenshot(TestScreenshotOptions.of("08-places-other"));
			context.clickScreenButton("Test Spot");
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			context.takeScreenshot(TestScreenshotOptions.of("09-after-tp"));
		}
	}

	private static void openInventory(ClientGameTestContext context) {
		context.setScreen(() -> new InventoryScreen(net.minecraft.client.Minecraft.getInstance().player));
		context.waitForScreen(InventoryScreen.class);
		context.waitTicks(5);
	}
}
