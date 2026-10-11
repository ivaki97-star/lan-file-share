package lan.quick;

import net.minecraft.network.FriendlyByteBuf;

/** One place: the site's Places tab entry, or a spot marked in game. dim is overworld, the_nether or the_end. */
public record Place(String title, String type, int x, int y, int z, String dim) {

	public static final String[] TYPES = {"Base", "Farm", "Village", "Portal", "Spawner", "Mine / Cave", "Structure", "Biome", "Shop", "Build", "Danger", "Other"};

	public void write(FriendlyByteBuf buf) {
		buf.writeUtf(title, 100);
		buf.writeUtf(type, 32);
		buf.writeInt(x);
		buf.writeInt(y);
		buf.writeInt(z);
		buf.writeUtf(dim, 16);
	}

	public static Place read(FriendlyByteBuf buf) {
		return new Place(buf.readUtf(100), buf.readUtf(32), buf.readInt(), buf.readInt(), buf.readInt(), buf.readUtf(16));
	}

	/** "Village" from "old village by the river", "Farm" from "cow farm", else "Other". */
	public static String guessType(String title) {
		String t = title.toLowerCase();
		if (t.contains("village")) return "Village";
		if (t.contains("farm")) return "Farm";
		if (t.contains("portal") || t.contains("nether")) return "Portal";
		if (t.contains("spawner")) return "Spawner";
		if (t.contains("mine") || t.contains("cave") || t.contains("ravine")) return "Mine / Cave";
		if (t.contains("base") || t.contains("home") || t.contains("house")) return "Base";
		if (t.contains("shop") || t.contains("trade")) return "Shop";
		if (t.contains("temple") || t.contains("fortress") || t.contains("mansion") || t.contains("monument") || t.contains("stronghold") || t.contains("outpost") || t.contains("city")) return "Structure";
		if (t.contains("danger") || t.contains("boss") || t.contains("warden")) return "Danger";
		return "Other";
	}
}
