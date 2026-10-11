package lan.quick;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** config/lanquick.json on the server. The client never reads it. */
public class QuickConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	/** The LAN File Share site, e.g. https://thelanparty.duckdns.org. Empty = places come only from the local file. */
	public String siteUrl = "";
	/** ADMIN_TOKEN from the site's .env, so the server can read and add places when the site needs a login. */
	public String adminToken = "";
	/** true: every player may use the quick menu. false: ops only (permission level 2). */
	public boolean everyoneCanUse = true;
	/** How often the places are re-read from the site, in seconds. */
	public int placesRefreshSeconds = 60;
	/** Animals this close to you move when you send animals somewhere (blocks). */
	public int animalsRadius = 24;
	/** Default boat speeds offered on the Boat tab (blocks per second, for the Boat Fly mod). */
	public double[] boatSpeeds = {8, 20, 50, 100};

	public static QuickConfig load(Path dir) {
		Path file = dir.resolve("lanquick.json");
		if (Files.exists(file)) {
			try {
				QuickConfig c = GSON.fromJson(Files.readString(file), QuickConfig.class);
				if (c != null) {
					if (c.boatSpeeds == null || c.boatSpeeds.length == 0) c.boatSpeeds = new double[]{8, 20, 50, 100};
					return c;
				}
			} catch (IOException | RuntimeException e) {
				LanQuick.LOGGER.warn("lanquick.json could not be read, using defaults: {}", e.getMessage());
			}
		}
		QuickConfig c = new QuickConfig();
		c.save(dir);
		return c;
	}

	public void save(Path dir) {
		try {
			Files.createDirectories(dir);
			Files.writeString(dir.resolve("lanquick.json"), GSON.toJson(this));
		} catch (IOException e) {
			LanQuick.LOGGER.warn("lanquick.json could not be written: {}", e.getMessage());
		}
	}

	public String siteBase() {
		String s = siteUrl == null ? "" : siteUrl.trim();
		while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
		return s;
	}
}
