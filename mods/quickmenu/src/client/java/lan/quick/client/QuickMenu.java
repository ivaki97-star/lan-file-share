package lan.quick.client;

import lan.quick.Animals;
import lan.quick.Place;
import lan.quick.client.mixin.ContainerScreenAccessor;
import lan.quick.net.QuickSyncPayload;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenKeyboardEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenMouseEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The quick menu on the survival inventory.
 *
 * Recipe book closed: a column of icon tabs to the right of the inventory and a side panel next to it (vanilla widgets).
 * Recipe book open, or no room: only the icon column; a click opens the modal.
 * The modal is a solid window in the middle of the screen with the same icon tabs along its top edge, drawn on top of
 * everything and swallowing every click and key except Esc (closes the modal) and the inventory key (closes it all).
 *
 * Every action sends a /quick command (or Boat Fly's /boatspeed), so the server decides what is allowed.
 */
public class QuickMenu {
	// ---- what the server told us (QuickSyncPayload) ----
	private static List<Place> places = List.of();
	private static boolean canUse = false, hasHome = false, hasDeath = false, known = false;
	private static double[] boatSpeeds = {8, 20, 50, 100};
	// remembered between openings
	private static int tab = 0;
	private static String category = "";
	private static int page = 0;
	private static int bringCount = 1; // 1, 5 or 0 = all nearby

	static void update(QuickSyncPayload p) {
		places = p.places();
		canUse = p.canUse();
		hasHome = p.hasHome();
		hasDeath = p.hasDeath();
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

	// ---- tabs ----
	private record Tab(String name, ItemStack icon) {}
	private static final Tab[] TABS = {
		new Tab("Places", new ItemStack(Items.COMPASS)),
		new Tab("Weather", new ItemStack(Items.CLOCK)),
		new Tab("Boat", new ItemStack(Items.OAK_BOAT)),
		new Tab("Animals", new ItemStack(Items.WHEAT)),
		new Tab("Me", new ItemStack(Items.ENDER_PEARL)),
	};
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

	// ---- a piece of content, laid out relative to the content origin; drawn as a widget (side) or by hand (modal) ----
	enum Kind { BUTTON, CHIP, ICON }
	record Box(int x, int y, int w, int h, String label, ItemStack icon, String tooltip, Runnable action, boolean enabled, boolean selected, Kind kind) {
		boolean hit(double mx, double my, int ox, int oy) {
			return mx >= ox + x && mx < ox + x + w && my >= oy + y && my < oy + y + h;
		}
	}

	private static final int ICON = 20, GAP = 2, BTN_H = 18, CHIP_H = 12, CELL = 22;

	private static QuickMenu current;
	private final Minecraft client;
	private final InventoryScreen screen;
	private final ContainerScreenAccessor acc;
	private final List<AbstractWidget> mine = new ArrayList<>();
	// side layout
	private int left, top, imageW, imageH, iconX, panelX, panelW;
	private boolean compact;
	// modal
	private boolean modalOpen;
	private int mx, my, mw, mh, cx, cy, cw, ch;
	private List<Box> modalBoxes = List.of();
	private double hoverX, hoverY;

	QuickMenu(Minecraft client, InventoryScreen screen) {
		this.client = client;
		this.screen = screen;
		this.acc = (ContainerScreenAccessor) screen;
	}

	/** Side mode geometry. Returns true when something moved (the recipe book opened or closed). */
	private boolean measure() {
		int l = acc.lanquick$leftPos(), t = acc.lanquick$topPos(), w = acc.lanquick$imageWidth(), h = acc.lanquick$imageHeight();
		int ix = l + w + 4;
		int px = ix + ICON + GAP;
		int pw = Math.min(120, screen.width - px - 4);
		boolean bookOpen = l > (screen.width - w) / 2 + 1;
		boolean cmp = bookOpen || pw < 72;
		boolean changed = l != left || t != top || w != imageW || h != imageH || cmp != compact || pw != panelW;
		left = l; top = t; imageW = w; imageH = h; iconX = ix; panelX = px; panelW = Math.max(72, pw); compact = cmp;
		return changed;
	}

	void attach() {
		current = this;
		measure();
		rebuild();

		ScreenEvents.afterTick(screen).register(scr -> {
			if (measure()) rebuild();
		});
		ScreenEvents.afterBackground(screen).register((scr, graphics, mouseX, mouseY, delta) -> {
			if (compact) return;
			int bottom = top + imageH;
			graphics.fill(iconX - 2, top, panelX + panelW + 2, bottom, 0xC0141414);
			graphics.fill(panelX - 1, top, panelX, bottom, 0x40FFFFFF);
			Font font = client.font;
			graphics.text(font, TABS[tab].name(), panelX + 3, top + 3, 0xFFE0E0E0, false);
			String hint = hint();
			if (!hint.isEmpty()) graphics.text(font, hint, panelX + 3, bottom - 10, 0xFF9A9A9A, false);
		});
		ScreenEvents.afterExtract(screen).register((scr, graphics, mouseX, mouseY, delta) -> {
			if (modalOpen) drawModal(graphics, mouseX, mouseY);
		});
		ScreenEvents.remove(screen).register(scr -> {
			if (current == this) current = null;
		});

		// While the modal is open nothing underneath may react: swallow every click, drag, scroll and key, except
		// Esc (closes the modal) and the inventory key (closes the whole screen, as it always does).
		ScreenMouseEvents.allowMouseClick(screen).register((scr, ev) -> {
			if (!modalOpen) return true;
			if (ev.button() == 0) clickModal(ev.x(), ev.y());
			return false;
		});
		ScreenMouseEvents.allowMouseRelease(screen).register((scr, ev) -> !modalOpen);
		ScreenMouseEvents.allowMouseDrag(screen).register((scr, ev, dx, dy) -> !modalOpen);
		ScreenMouseEvents.allowMouseScroll(screen).register((scr, x, y, hAmount, vAmount) -> {
			if (!modalOpen) return true;
			if (vAmount < 0) nextPage(); else if (vAmount > 0) prevPage();
			return false;
		});
		ScreenKeyboardEvents.allowKeyPress(screen).register((scr, ev) -> {
			if (!modalOpen) return true;
			if (ev.isEscape()) { closeModal(); return false; }
			return client.options.keyInventory.matches(ev);
		});
		ScreenKeyboardEvents.allowCharType(screen).register((scr, ev) -> !modalOpen);
	}

	private String hint() {
		if (!canUse) return "Ops only on this server";
		return switch (tab) {
			case 0 -> places.isEmpty() ? "/quick mark <name> adds one" : filtered().size() + " of " + places.size() + " places";
			case 2 -> "Needs the Boat Fly mod";
			case 3 -> bringCount == 0 ? "every one within " + Animals.ALL_RADIUS + " blocks" : "the nearest " + (bringCount == 1 ? "one" : bringCount) + " comes to you";
			default -> "";
		};
	}

	// ---- side mode: icon column + panel made of vanilla widgets ----

	void rebuild() {
		List<AbstractWidget> widgets = Screens.getWidgets(screen);
		widgets.removeAll(mine);
		mine.clear();

		for (int i = 0; i < TABS.length; i++) {
			int idx = i;
			IconButton b = new IconButton(iconX, top + i * (ICON + GAP), ICON, Component.literal(TABS[i].name()), TABS[i].icon(), btn -> {
				// compact: the icon opens the modal; side panel: the icon selects, clicking the selected one opens the modal
				if (compact || idx == tab) openModal(idx);
				else { tab = idx; page = 0; rebuild(); }
			});
			b.selected = i == tab && !compact;
			add(b);
		}
		rebuildModal();
		if (compact) return;

		int contentH = imageH - 14 - 12;
		for (Box box : content(panelW, contentH)) {
			int x = panelX + box.x(), y = top + 14 + box.y();
			AbstractWidget w;
			if (box.kind() == Kind.ICON) {
				IconButton ib = new IconButton(x, y, box.w(), Component.literal(box.label()), box.icon(), btn -> box.action().run());
				w = ib;
			} else {
				Button.Builder bb = Button.builder(Component.literal(box.label()), btn -> box.action().run()).bounds(x, y, box.w(), box.h());
				if (box.tooltip() != null) bb.tooltip(Tooltip.create(Component.literal(box.tooltip())));
				w = bb.build();
			}
			w.active = box.enabled() && !box.selected() && canUse;
			add(w);
		}
	}

	private void add(AbstractWidget w) {
		mine.add(w);
		Screens.getWidgets(screen).add(w);
	}

	// ---- the content of the current tab, laid out for a w x h area ----

	List<Box> content(int w, int h) {
		List<Box> out = new ArrayList<>();
		int cols = w >= 200 ? 2 : 1;
		switch (tab) {
			case 0 -> placePicker(out, w, h, p -> run("quick tp " + p.title(), true));
			case 1 -> buttons(out, w, cols, List.of(
				new String[]{"Day", "quick day"}, new String[]{"Night", "quick night"},
				new String[]{"Clear sky", "quick clear"}, new String[]{"Rain", "quick rain"}));
			case 2 -> {
				List<String[]> items = new ArrayList<>();
				for (double s : boatSpeeds) items.add(new String[]{s == 8 ? "Normal (8)" : fmt(s) + " blocks/s", "boatspeed " + fmt(s), "noclose"});
				buttons(out, w, cols, items);
			}
			case 3 -> animalPicker(out, w, h);
			case 4 -> {
				List<String[]> items = new ArrayList<>();
				if (hasDeath) items.add(new String[]{"Back to death", "quick back"});
				if (hasHome) items.add(new String[]{"Home", "quick home"});
				items.add(new String[]{"Set home here", "quick sethome"});
				items.add(new String[]{"Spawn", "quick spawn"});
				items.add(new String[]{"Share coords", "quick coords"});
				items.add(new String[]{"Mark spot...", "chat:/quick mark "});
				items.add(new String[]{"Keep inventory", "quick keepinv"});
				buttons(out, w, cols, items);
			}
		}
		return out;
	}

	/** Full-width buttons, in 1 or 2 columns. Item = {label, command[, "noclose"]}; "chat:" prefix opens the chat prefilled. */
	private void buttons(List<Box> out, int w, int cols, List<String[]> items) {
		int bw = (w - GAP * (cols - 1)) / cols;
		for (int i = 0; i < items.size(); i++) {
			String[] it = items.get(i);
			boolean close = it.length < 3;
			Runnable action = it[1].startsWith("chat:") ? () -> client.setScreenAndShow(new ChatScreen(it[1].substring(5), false)) : () -> run(it[1], close);
			out.add(new Box((i % cols) * (bw + GAP), (i / cols) * (BTN_H + GAP), bw, BTN_H, it[0], null, null, action, true, false, Kind.BUTTON));
		}
	}

	private List<Place> filtered() {
		List<Place> out = new ArrayList<>();
		for (Place p : places) if (category.isEmpty() || typeOf(p).equals(category)) out.add(p);
		out.sort(Comparator.comparing(p -> p.title().toLowerCase()));
		return out;
	}

	private static String typeOf(Place p) {
		return p.type() == null || p.type().isEmpty() ? "Other" : p.type();
	}

	private int chips(List<Box> out, int w, int y, List<String> labels, List<String> keys, String selectedKey, Consumer<String> onPick) {
		int perRow = Math.max(2, Math.min(labels.size(), w / 46));
		int cw2 = (w - GAP * (perRow - 1)) / perRow;
		for (int i = 0; i < labels.size(); i++) {
			String k = keys.get(i);
			out.add(new Box((i % perRow) * (cw2 + GAP), y + (i / perRow) * (CHIP_H + GAP), cw2, CHIP_H, labels.get(i), null, null,
				() -> onPick.accept(k), true, k.equals(selectedKey), Kind.CHIP));
		}
		return y + ((labels.size() + perRow - 1) / perRow) * (CHIP_H + GAP) + 2;
	}

	private void pager(List<Box> out, int w, int y, int pages) {
		if (pages <= 1) return;
		int half = (w - GAP) / 2;
		out.add(new Box(0, y, half, CHIP_H + 2, "<", null, null, this::prevPage, page > 0, false, Kind.CHIP));
		out.add(new Box(half + GAP, y, half, CHIP_H + 2, ">", null, null, this::nextPage, page < pages - 1, false, Kind.CHIP));
	}

	private void placePicker(List<Box> out, int w, int h, Consumer<Place> onPick) {
		int y = 0;
		List<String> types = new ArrayList<>();
		for (String t : SHORT.keySet()) if (!t.isEmpty() && places.stream().anyMatch(p -> typeOf(p).equals(t))) types.add(t);
		if (!category.isEmpty() && !types.contains(category)) category = "";
		if (types.size() > 1) {
			List<String> keys = new ArrayList<>(), labels = new ArrayList<>();
			keys.add(""); labels.add("All");
			for (String t : types) { keys.add(t); labels.add(SHORT.get(t)); }
			y = chips(out, w, y, labels, keys, category, k -> { category = k; page = 0; rebuild(); });
		}
		List<Place> list = filtered();
		int cols = w >= 200 ? 2 : 1;
		int bw = (w - GAP * (cols - 1)) / cols;
		int rows = Math.max(1, (h - y) / (BTN_H + GAP));
		int perPage = rows * cols;
		if (list.size() > perPage) perPage = Math.max(1, (rows - 1) * cols); // keep a row for < >
		int pages = Math.max(1, (list.size() + perPage - 1) / perPage);
		if (page >= pages) page = pages - 1;
		int start = page * perPage;
		for (int i = start; i < Math.min(list.size(), start + perPage); i++) {
			Place p = list.get(i);
			int k = i - start;
			String dim = p.dim().equals("overworld") ? "" : p.dim().equals("the_nether") ? "  (nether)" : "  (end)";
			out.add(new Box((k % cols) * (bw + GAP), y + (k / cols) * (BTN_H + GAP), bw, BTN_H, p.title(), null,
				typeOf(p) + " · " + p.x() + " " + p.y() + " " + p.z() + dim, () -> onPick.accept(p), true, false, Kind.BUTTON));
		}
		int used = (int) Math.ceil(Math.min(list.size() - start, perPage) / (double) cols);
		pager(out, w, y + Math.max(used, 0) * (BTN_H + GAP), pages);
	}

	private void animalPicker(List<Box> out, int w, int h) {
		int y = chips(out, w, 0, List.of("Nearest 1", "Nearest 5", "All nearby"), List.of("1", "5", "0"), Integer.toString(bringCount),
			k -> { bringCount = Integer.parseInt(k); rebuild(); });
		int perRow = Math.max(1, (w + GAP) / (CELL + GAP));
		int rows = Math.max(1, (h - y) / (CELL + GAP));
		int perPage = perRow * rows;
		List<Animals.Kind> kinds = Animals.ALL;
		if (kinds.size() > perPage) perPage = Math.max(1, perRow * (rows - 1));
		int pages = Math.max(1, (kinds.size() + perPage - 1) / perPage);
		if (page >= pages) page = pages - 1;
		int start = page * perPage;
		for (int i = start; i < Math.min(kinds.size(), start + perPage); i++) {
			Animals.Kind kind = kinds.get(i);
			int k = i - start;
			ItemStack egg = new ItemStack(BuiltInRegistries.ITEM.getOptional(Identifier.withDefaultNamespace(kind.id() + "_spawn_egg")).orElse(Items.EGG));
			out.add(new Box((k % perRow) * (CELL + GAP), y + (k / perRow) * (CELL + GAP), CELL, CELL, kind.label(), egg,
				"Bring " + kind.label().toLowerCase(), () -> run("quick bring " + kind.id() + " " + bringCount, true), true, false, Kind.ICON));
		}
		int used = (int) Math.ceil(Math.min(kinds.size() - start, perPage) / (double) perRow);
		pager(out, w, y + Math.max(used, 0) * (CELL + GAP), pages);
	}

	private void nextPage() { page++; rebuild(); }
	private void prevPage() { if (page > 0) { page--; rebuild(); } }

	// ---- the modal ----

	public static void openModal(int which) {
		if (current != null) current.openModalNow(which);
	}

	private void openModalNow(int which) {
		tab = which;
		page = 0;
		modalOpen = true;
		mw = Math.min(300, screen.width - 16);
		mh = Math.min(210, screen.height - 44);
		mx = (screen.width - mw) / 2;
		my = (screen.height - mh) / 2 + 10;
		cx = mx + 6;
		cy = my + 16;
		cw = mw - 12;
		ch = mh - 16 - 14;
		rebuild();
	}

	public void closeModal() {
		modalOpen = false;
		modalBoxes = List.of();
		rebuild();
	}

	public boolean isModalOpen() {
		return modalOpen;
	}

	private static final int BODY = 0xFFC6C6C6, LIGHT = 0xFFFFFFFF, DARK = 0xFF555555, EDGE = 0xFF000000;

	private void drawModal(GuiGraphicsExtractor g, int mouseX, int mouseY) {
		hoverX = mouseX; hoverY = mouseY;
		Font font = client.font;
		g.fill(0, 0, screen.width, screen.height, 0x90000000);

		// tabs along the top edge, like the recipe book's but turned on their side
		int tabW = 28, tabH = 24, tx0 = mx + 6;
		for (int i = 0; i < TABS.length; i++) {
			int tx = tx0 + i * (tabW + 2);
			boolean sel = i == tab;
			int ty = sel ? my - tabH + 2 : my - tabH + 6;
			if (!sel) window(g, tx, ty, tabW, tabH, 0xFFA0A0A0);
		}
		window(g, mx, my, mw, mh, BODY);
		for (int i = 0; i < TABS.length; i++) {
			int tx = tx0 + i * (tabW + 2);
			if (i != tab) continue;
			int ty = my - tabH + 2;
			window(g, tx, ty, tabW, tabH + 4, BODY);
			g.fill(tx + 1, my - 1, tx + tabW - 1, my + 3, BODY); // merge into the window
		}
		for (int i = 0; i < TABS.length; i++) {
			int tx = tx0 + i * (tabW + 2);
			int ty = i == tab ? my - tabH + 2 : my - tabH + 6;
			g.item(TABS[i].icon(), tx + (tabW - 16) / 2, ty + 3);
			if (hoverX >= tx && hoverX < tx + tabW && hoverY >= ty && hoverY < ty + tabH) g.setTooltipForNextFrame(Component.literal(TABS[i].name()), mouseX, mouseY);
		}

		g.text(font, TABS[tab].name(), mx + 7, my + 5, 0xFF3F3F3F, false);
		// close box
		int bx = mx + mw - 15, by = my + 4;
		boolean hc = hoverX >= bx && hoverX < bx + 11 && hoverY >= by && hoverY < by + 11;
		g.fill(bx, by, bx + 11, by + 11, hc ? 0xFF8B3A3A : 0xFF6F6F6F);
		g.text(font, "x", bx + 3, by + 1, 0xFFFFFFFF, false);
		String hint = hint();
		if (!hint.isEmpty()) g.text(font, hint, mx + 7, my + mh - 12, 0xFF6F6F6F, false);

		for (Box b : modalBoxes) {
			int x = cx + b.x(), y = cy + b.y();
			boolean hover = b.enabled() && !b.selected() && canUse && b.hit(hoverX, hoverY, cx, cy);
			if (b.kind() == Kind.ICON) {
				g.fill(x, y, x + b.w(), y + b.h(), hover ? 0xFF8E8E8E : 0xFF6F6F6F);
				g.fill(x + 1, y + 1, x + b.w() - 1, y + b.h() - 1, hover ? 0xFFB8B8B8 : 0xFF8B8B8B);
				g.item(b.icon(), x + (b.w() - 16) / 2, y + (b.h() - 16) / 2);
			} else {
				int inner = b.selected() ? 0xFFE8E8E8 : !b.enabled() || !canUse ? 0xFF8A8A8A : hover ? 0xFF9C9C9C : 0xFF6F6F6F;
				g.fill(x, y, x + b.w(), y + b.h(), 0xFF2B2B2B);
				g.fill(x + 1, y + 1, x + b.w() - 1, y + b.h() - 1, inner);
				int color = b.selected() ? 0xFF202020 : !b.enabled() || !canUse ? 0xFFC0C0C0 : 0xFFFFFFFF;
				String label = font.width(b.label()) > b.w() - 6 ? font.plainSubstrByWidth(b.label(), b.w() - 10) + "…" : b.label();
				g.text(font, label, x + (b.w() - font.width(label)) / 2, y + (b.h() - 8) / 2, color, !b.selected());
			}
			if (hover && b.tooltip() != null) g.setTooltipForNextFrame(Component.literal(b.tooltip()), mouseX, mouseY);
		}
	}

	/** A vanilla-looking window: black edge, light top-left, dark bottom-right, flat body. */
	private static void window(GuiGraphicsExtractor g, int x, int y, int w, int h, int body) {
		g.fill(x - 1, y - 1, x + w + 1, y + h + 1, EDGE);
		g.fill(x, y, x + w, y + h, body);
		g.fill(x, y, x + w - 2, y + 2, LIGHT);
		g.fill(x, y, x + 2, y + h - 2, LIGHT);
		g.fill(x + 2, y + h - 2, x + w, y + h, DARK);
		g.fill(x + w - 2, y + 2, x + w, y + h, DARK);
	}

	private void clickModal(double x, double y) {
		int tabW = 28, tabH = 24, tx0 = mx + 6;
		for (int i = 0; i < TABS.length; i++) {
			int tx = tx0 + i * (tabW + 2), ty = i == tab ? my - tabH + 2 : my - tabH + 6;
			if (x >= tx && x < tx + tabW && y >= ty && y < ty + tabH) { tab = i; page = 0; rebuild(); return; }
		}
		int bx = mx + mw - 15, by = my + 4;
		if (x >= bx && x < bx + 11 && y >= by && y < by + 11) { closeModal(); return; }
		if (x < mx - 1 || x >= mx + mw + 1 || y < my - tabH || y >= my + mh + 1) { closeModal(); return; }
		if (!canUse) return;
		for (Box b : modalBoxes) {
			if (b.enabled() && !b.selected() && b.hit(x, y, cx, cy)) { b.action().run(); return; }
		}
	}

	/** Used by the game test: presses the box with this label in the open modal. */
	public boolean press(String label) {
		for (Box b : modalBoxes) if (b.label().equals(label) && b.enabled()) { b.action().run(); return true; }
		return false;
	}

	public static QuickMenu current() {
		return current;
	}

	private void rebuildModal() {
		modalBoxes = modalOpen ? content(cw, ch) : List.of();
	}

	// ---- helpers ----

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
