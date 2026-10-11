package lan.quick;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Per-player homes, kept in config/lanquick-players.json. */
public class PlayerData {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	public record Pos(String dim, double x, double y, double z, float yaw, float pitch) {}

	private final Path file;
	private Map<String, Pos> homes = new HashMap<>();

	public PlayerData(Path configDir) {
		file = configDir.resolve("lanquick-players.json");
		if (Files.exists(file)) {
			try {
				Map<String, Pos> m = GSON.fromJson(Files.readString(file), new TypeToken<Map<String, Pos>>() {}.getType());
				if (m != null) homes = m;
			} catch (IOException | RuntimeException e) {
				LanQuick.LOGGER.warn("lanquick-players.json could not be read: {}", e.getMessage());
			}
		}
	}

	public Pos home(UUID id) {
		return homes.get(id.toString());
	}

	public void setHome(UUID id, Pos pos) {
		homes.put(id.toString(), pos);
		try {
			Files.createDirectories(file.getParent());
			Files.writeString(file, GSON.toJson(homes));
		} catch (IOException e) {
			LanQuick.LOGGER.warn("lanquick-players.json could not be written: {}", e.getMessage());
		}
	}
}
