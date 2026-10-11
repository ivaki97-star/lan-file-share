package lan.quick;

import java.util.List;

/** The creatures the Animals tab can fetch: entity id (minecraft:<id>) and the label shown. Spawn egg = <id>_spawn_egg. */
public final class Animals {
	public record Kind(String id, String label) {}

	public static final List<Kind> ALL = List.of(
		new Kind("villager", "Villager"),
		new Kind("wolf", "Dog / wolf"),
		new Kind("cat", "Cat"),
		new Kind("panda", "Panda"),
		new Kind("cow", "Cow"),
		new Kind("mooshroom", "Mooshroom"),
		new Kind("sheep", "Sheep"),
		new Kind("pig", "Pig"),
		new Kind("chicken", "Chicken"),
		new Kind("horse", "Horse"),
		new Kind("donkey", "Donkey"),
		new Kind("mule", "Mule"),
		new Kind("llama", "Llama"),
		new Kind("camel", "Camel"),
		new Kind("goat", "Goat"),
		new Kind("fox", "Fox"),
		new Kind("rabbit", "Rabbit"),
		new Kind("bee", "Bee"),
		new Kind("parrot", "Parrot"),
		new Kind("axolotl", "Axolotl"),
		new Kind("frog", "Frog"),
		new Kind("turtle", "Turtle"),
		new Kind("sniffer", "Sniffer"),
		new Kind("armadillo", "Armadillo"),
		new Kind("allay", "Allay"),
		new Kind("iron_golem", "Iron golem"),
		new Kind("snow_golem", "Snow golem")
	);

	/** How far "nearest" looks, in blocks. Anything further is in chunks that are probably not loaded anyway. */
	public static final int SEARCH_RADIUS = 192;
	/** "All nearby" means within this many blocks. */
	public static final int ALL_RADIUS = 48;

	public static Kind find(String id) {
		for (Kind k : ALL) if (k.id().equalsIgnoreCase(id)) return k;
		return null;
	}

	private Animals() {}
}
