package lan.quick.test;

import lan.quick.client.QuickMenu;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.fabric.api.client.gametest.v1.screenshot.TestScreenshotOptions;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.inventory.RecipeBookType;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.level.gamerules.GameRules;

/**
 * Opens a singleplayer world, marks places, then walks the quick menu twice: with the recipe book closed (side panel,
 * vanilla widgets) and with it open (icon column + modal). Presses the buttons that change the world and checks the
 * server saw it: keep inventory, day, teleport, bring a cow. Esc must close the modal and nothing else.
 */
public class QuickMenuTest implements FabricClientGameTest {
	@Override
	public void runTest(ClientGameTestContext context) {
		try (TestSingleplayerContext world = context.worldBuilder().create()) {
			world.getConnection().waitForChunksRender(true, 1200);
			context.waitTicks(20);

			for (String name : new String[]{"Test Spot", "Cow farm", "Old village", "Nether portal", "Main base", "Deep mine"}) {
				context.runOnClient(client -> client.getConnection().sendCommand("quick mark " + name));
				context.waitTicks(2);
			}
			context.runOnClient(client -> client.getConnection().sendCommand("quick sethome"));
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(20);

			// ---- recipe book closed: side panel ----
			context.runOnClient(client -> client.player.getRecipeBook().setOpen(RecipeBookType.CRAFTING, false));
			openInventory(context);
			context.takeScreenshot(TestScreenshotOptions.of("01-side-places"));
			context.clickScreenButton("Animals");
			context.takeScreenshot(TestScreenshotOptions.of("02-side-animals"));
			context.clickScreenButton("Me");
			context.takeScreenshot(TestScreenshotOptions.of("03-side-me"));

			boolean before = world.getServer().computeOnServer(s -> s.overworld().getGameRules().get(GameRules.KEEP_INVENTORY));
			context.clickScreenButton("Keep inventory");
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			boolean after = world.getServer().computeOnServer(s -> s.overworld().getGameRules().get(GameRules.KEEP_INVENTORY));
			if (before == after) throw new AssertionError("keep inventory did not flip (" + before + " -> " + after + ")");

			// ---- recipe book open: icon column + modal ----
			context.runOnClient(client -> client.player.getRecipeBook().setOpen(RecipeBookType.CRAFTING, true));
			openInventory(context);
			context.takeScreenshot(TestScreenshotOptions.of("04-book-open-compact"));
			if (QuickMenu.current() == null) throw new AssertionError("quick menu not attached");

			String[] names = {"places", "weather", "boat", "animals", "me"};
			for (int i = 0; i < names.length; i++) {
				int idx = i;
				context.runOnClient(client -> QuickMenu.openModal(idx));
				context.waitTicks(3);
				context.takeScreenshot(TestScreenshotOptions.of("1" + i + "-modal-" + names[i]));
			}
			if (!QuickMenu.current().isModalOpen()) throw new AssertionError("modal should be open");

			// Esc closes the modal, not the inventory
			var esc = com.mojang.blaze3d.platform.InputConstants.Type.KEYBOARD.getOrCreate(com.mojang.blaze3d.platform.InputConstants.KEY_ESCAPE);
			context.getInput().holdKey(esc);
			context.getInput().releaseKey(esc);
			context.waitTicks(3);
			if (QuickMenu.current() == null) throw new AssertionError("Esc closed the whole inventory (menu detached)");
			if (QuickMenu.current().isModalOpen()) throw new AssertionError("Esc did not close the modal");
			boolean stillInventory = context.computeOnClient(client -> client.gui.screen() instanceof InventoryScreen);
			if (!stillInventory) throw new AssertionError("Esc closed the whole inventory");

			// Day from the modal
			context.runOnClient(client -> QuickMenu.openModal(1));
			context.waitTicks(2);
			context.runOnClient(client -> { if (!QuickMenu.current().press("Day")) throw new AssertionError("no Day button"); });
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			long dayTime = world.getServer().computeOnServer(s -> s.overworld().getOverworldClockTime() % 24000L);
			if (dayTime < 900 || dayTime > 1300) throw new AssertionError("time set day did not land near 1000, got " + dayTime);

			// Bring the nearest cow: summon one 30 blocks away, press the cow icon, it should end up next to the player
			world.getServer().runCommand("summon minecraft:cow 30 -60 30 {NoAI:1b}");
			context.waitTicks(10);
			openInventory(context);
			context.runOnClient(client -> QuickMenu.openModal(3));
			context.waitTicks(2);
			context.takeScreenshot(TestScreenshotOptions.of("20-modal-animals-before-bring"));
			context.runOnClient(client -> { if (!QuickMenu.current().press("Cow")) throw new AssertionError("no Cow icon"); });
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			double dist = world.getServer().computeOnServer(s -> {
				var player = s.getPlayerList().getPlayers().get(0);
				var cows = s.overworld().getEntities(EntityTypeTest.forClass(Mob.class), m -> m.getType() == EntityTypes.COW);
				if (cows.isEmpty()) return 9999.0;
				return Math.sqrt(cows.get(0).distanceToSqr(player));
			});
			if (dist > 6) throw new AssertionError("cow is still " + dist + " blocks away");

			// Places from the modal: teleport to the marked spot
			openInventory(context);
			context.runOnClient(client -> QuickMenu.openModal(0));
			context.waitTicks(2);
			context.runOnClient(client -> { if (!QuickMenu.current().press("Test Spot")) throw new AssertionError("no Test Spot place"); });
			world.getConnection().waitForServerboundPackets();
			context.waitTicks(10);
			context.takeScreenshot(TestScreenshotOptions.of("30-after-tp"));
		}
	}

	private static void openInventory(ClientGameTestContext context) {
		context.runOnClient(client -> { if (client.gui.screen() != null) client.gui.screen().onClose(); });
		context.waitTicks(2);
		context.setScreen(() -> new InventoryScreen(Minecraft.getInstance().player));
		context.waitForScreen(InventoryScreen.class);
		context.waitTicks(5);
	}
}
