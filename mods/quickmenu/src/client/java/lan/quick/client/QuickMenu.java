package lan.quick.client;

import lan.quick.Place;
import lan.quick.net.QuickSyncPayload;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The quick menu to the right of the survival inventory. Level 1: a column of icon tabs. Level 2 (Places, Animals):
 * one small tab per place type, then the places of that type, paged. Every button sends a /quick command (or Boat
 * Fly's /boatspeed), so the server decides what is allowed.
 */
public class QuickMenu {
	// ---- what the server told us (QuickSyncPayload) ----
	private static List<Place> places = List.of();
	private static boolean canUse = false, hasHome = false, hasDeath = false, known = false;
	private static int animalsRadius = 24;
	private static double[] boatSpeeds = {8, 20, 50, 100};
	// remembered between openings
	private static int tab = 0;
	private static String category = "";
	private static int page = 0;

	static void update(QuickSyncPayload p) {
		places = p.places();
		canUse = p.canUse();
		hasHome = p.hasHome();
		hasDeath = p.hasDeath();
		animalsRadius = p.animalsRadius();
		boatSpeeds = p.boatSpeeds().length == 0 ? new double[]{8, 20, 50, 100} : p.boatSpeeds();
		known = true;
		if (current != null) current.rebuild();
	}

	static void reset() {
		places = List.of();
		canUse = hasHome = hasDeath = known = false;
		current = null;
	}

	static boolean known() {
		return known;
	}

	// ---- level 1 ----
	private record Tab(String name, ItemStack icon) {}
	private static final Tab[] TABS = {
		new Tab("Places", new ItemStack(Items.COMPASS)),
		new Tab("Weather", new ItemStack(Items.CLOCK)),
		new Tab("Boat", new ItemStack(Items.OAK_BOAT)),
		new Tab("Animals", new ItemStack(Items.WHEAT)),
		new Tab("Me", new ItemStack(Items.ENDER_PEARL)),
	};
	/** Short labels for the level-2 type tabs, in the site's order. "" = every place. */
	private static final Map<String, String> SHORT = new LinkedHashMap<>();
	static {
		SHORT.put("", "All");
		SHORT.put("Base", "Base");
		SHORT.put("Farm", "Farm");
		SHORT.put("Village", "Vill.");
		SHORT.put("Portal", "Portal");
		SHORT.put("Spawner", "Spawn.");
		SHORT.put("Mine / Cave", "Mine");
		SHORT.put("Structure", "Struct.");
		SHORT.put("Biome", "Biome");
		SHORT.put("Shop", "Shop");
		SHORT.put("Build", "Build");
		SHORT.put("Danger", "Danger");
		SHORT.put("Other", "Other");
	}

	private static final int INV_W = 176, INV_H = 166, ICON = 20, GAP = 2, BTN_H = 18, CHIP_H = 12;

	private static QuickMenu current;
	private final Minecraft client;
	private final InventoryScreen screen;
	private final List<AbstractWidget> mine = new ArrayList<>();
	private final int iconX, panelX, panelW, top, bottom;

	QuickMenu(Minecraft client, InventoryScreen screen) {
		this.client = client;
		this.screen = screen;
		int left = (screen.width - INV_W) / 2;
		this.top = (screen.height - INV_H) / 2;
		this.bottom = top + INV_H;
		this.iconX = left + INV_W + 4;
		this.panelX = iconX + ICON + GAP;
		// as wide as the screen allows, within reason
		this.panelW = Math.max(72, Math.min(120, screen.width - panelX - 4));
	}

	void attach() {
		current = this;
		rebuild();
		ScreenEvents.afterBackground(screen).register((scr, graphics, mouseX, mouseY, delta) -> {
			graphics.fill(iconX - 2, top, panelX + panelW + 2, bottom, 0xC0141414);
			graphics.fill(panelX - 1, top, panelX, bottom, 0x40FFFFFF);
			Font font = Screens.getFont(screen);
			graphics.text(font, TABS[tab].name(), panelX + 3, top + 3, 0xFFE0E0E0, false);
			String hint = hint();
			if (!hint.isEmpty()) graphics.text(font, hint, panelX + 3, bottom - 10, 0xFF9A9A9A, false);
		});
		ScreenEvents.remove(screen).register(scr -> {
			if (current == this) current = null;
		});
	}

	private String hint() {
		if (!canUse) return "Ops only on this server";
		return switch (tab) {
			case 0 -> places.isEmpty() ? "/quick mark <name> adds one" : filtered().size() + " of " + places.size() + " places";
			case 2 -> "Needs the Boat Fly mod";
			case 3 -> "within " + animalsRadius + " blocks of you";
			default -> "";
		};
	}

	void rebuild() {
		List<AbstractWidget> widgets = Screens.getWidgets(screen);
		widgets.removeAll(mine);
		mine.clear();

		for (int i = 0; i < TABS.length; i++) {
			int idx = i;
			IconButton b = new IconButton(iconX, top + i * (ICON + GAP), ICON, Component.literal(TABS[i].name()), TABS[i].icon(), btn -> { tab = idx; page = 0; rebuild(); });
			b.selected = i == tab;
			add(b);
		}

		int y = top + 14;
		switch (tab) {
			case 0 -> placePicker(y, p -> run("quick tp " + p.title(), true));
			case 1 -> {
				y = add(y, "Day", "quick day", true);
				y = add(y, "Night", "quick night", true);
				y = add(y, "Clear sky", "quick clear", true);
				y = add(y, "Rain", "quick rain", true);
			}
			case 2 -> {
				for (double s : boatSpeeds) y = add(y, s == 8 ? "Normal (8)" : fmt(s) + " blocks/s", "boatspeed " + fmt(s), false);
			}
			case 3 -> {
				y = add(y, "To coordinates...", btn -> client.setScreenAndShow(new ChatScreen("/quick animals ", false)), "Type x y z (and a radius), then Enter");
				placePicker(y, p -> run("quick animals place " + p.title(), true));
			}
			case 4 -> {
				if (hasDeath) y = add(y, "Back to death", "quick back", true);
				if (hasHome) y = add(y, "Home", "quick home", true);
				y = add(y, "Set home here", "quick sethome", true);
				y = add(y, "Spawn", "quick spawn", true);
				y = add(y, "Share coords", "quick coords", true);
				y = add(y, "Mark spot...", btn -> client.setScreenAndShow(new ChatScreen("/quick mark ", false)), "Type a name, then Enter. It lands on the site's Places tab.");
				y = add(y, "Keep inventory", "quick keepinv", true);
			}
		}
		if (!canUse) for (AbstractWidget w : mine) if (w.getX() >= panelX) w.active = false;
	}

	// ---- level 2: type tabs, then the places of that type ----

	private List<Place> filtered() {
		List<Place> out = new ArrayList<>();
		for (Place p : places) if (category.isEmpty() || typeOf(p).equals(category)) out.add(p);
		out.sort(Comparator.comparing(p -> p.title().toLowerCase()));
		return out;
	}

	private static String typeOf(Place p) {
		return p.type() == null || p.type().isEmpty() ? "Other" : p.type();
	}

	private void placePicker(int y, Consumer<Place> onPick) {
		// which types exist, in the site's order; the type tabs only appear once there is more than one type
		List<String> types = new ArrayList<>();
		for (String t : SHORT.keySet()) if (!t.isEmpty() && places.stream().anyMatch(p -> typeOf(p).equals(t))) types.add(t);
		if (!types.isEmpty() && !category.isEmpty() && !types.contains(category)) category = "";
		if (types.size() > 1) {
			List<String> chips = new ArrayList<>();
			chips.add("");
			chips.addAll(types);
			int perRow = panelW >= 100 ? 3 : 2;
			int w = (panelW - GAP * (perRow - 1)) / perRow;
			for (int i = 0; i < chips.size(); i++) {
				String t = chips.get(i);
				Button b = Button.builder(Component.literal(SHORT.get(t)), btn -> { category = t; page = 0; rebuild(); })
					.bounds(panelX + (i % perRow) * (w + GAP), y + (i / perRow) * (CHIP_H + GAP), w, CHIP_H).build();
				b.active = !t.equals(category);
				add(b);
			}
			y += ((chips.size() + perRow - 1) / perRow) * (CHIP_H + GAP) + 2;
		}

		List<Place> list = filtered();
		int rows = Math.max(1, (bottom - 12 - y) / (BTN_H + GAP));
		int perPage = list.size() > rows ? rows - 1 : rows; // keep one row for < > when paging
		int pages = Math.max(1, (list.size() + perPage - 1) / perPage);
		if (page >= pages) page = pages - 1;
		int start = page * perPage;
		for (int i = start; i < Math.min(list.size(), start + perPage); i++) {
			Place p = list.get(i);
			String dim = p.dim().equals("overworld") ? "" : p.dim().equals("the_nether") ? "  (nether)" : "  (end)";
			Button b = Button.builder(Component.literal(p.title()), btn -> onPick.accept(p))
				.bounds(panelX, y, panelW, BTN_H)
				.tooltip(Tooltip.create(Component.literal(typeOf(p) + " · " + p.x() + " " + p.y() + " " + p.z() + dim)))
				.build();
			add(b);
			y += BTN_H + GAP;
		}
		if (pages > 1) {
			int half = (panelW - GAP) / 2;
			Button prev = Button.builder(Component.literal("<"), btn -> { page--; rebuild(); }).bounds(panelX, y, half, BTN_H).build();
			Button next = Button.builder(Component.literal(">"), btn -> { page++; rebuild(); }).bounds(panelX + half + GAP, y, half, BTN_H).build();
			prev.active = page > 0;
			next.active = page < pages - 1;
			add(prev);
			add(next);
		}
	}

	// ---- helpers ----

	private int add(int y, String label, String command, boolean close) {
		return add(y, label, btn -> run(command, close), null);
	}

	private int add(int y, String label, Button.OnPress press, String tooltip) {
		Button.Builder b = Button.builder(Component.literal(label), press).bounds(panelX, y, panelW, BTN_H);
		if (tooltip != null) b.tooltip(Tooltip.create(Component.literal(tooltip)));
		add(b.build());
		return y + BTN_H + GAP;
	}

	private void add(AbstractWidget w) {
		mine.add(w);
		Screens.getWidgets(screen).add(w);
	}

	/** Sends a command as if typed in chat. Boat Fly's /boatspeed is a client command, which this path also reaches. */
	private void run(String command, boolean closeScreen) {
		if (client.getConnection() == null) return;
		client.getConnection().sendCommand(command);
		if (closeScreen) screen.onClose();
	}

	private static String fmt(double d) {
		return d == Math.rint(d) ? Integer.toString((int) d) : Double.toString(d);
	}
}
