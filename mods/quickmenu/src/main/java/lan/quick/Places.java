package lan.quick;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/**
 * The place list: what the site's Places tab holds (GET /api/pois, refreshed every few seconds in the background)
 * plus places marked in game. A mark goes to the site when one is configured, otherwise into
 * config/lanquick-places.json next to the server.
 */
public class Places {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NORMAL).build();

	private final QuickConfig config;
	private final Path localFile;
	private List<Place> site = new ArrayList<>();
	private List<Place> local = new ArrayList<>();
	private String lastSignature = "";
	private volatile boolean fetching = false;

	public Places(QuickConfig config, Path configDir) {
		this.config = config;
		this.localFile = configDir.resolve("lanquick-places.json");
		loadLocal();
	}

	public synchronized List<Place> all() {
		List<Place> out = new ArrayList<>(site);
		for (Place p : local) if (out.stream().noneMatch(q -> q.title().equalsIgnoreCase(p.title()))) out.add(p);
		return out;
	}

	public Place find(String title) {
		String t = title.trim();
		for (Place p : all()) if (p.title().equalsIgnoreCase(t)) return p;
		for (Place p : all()) if (p.title().toLowerCase().startsWith(t.toLowerCase())) return p;
		for (Place p : all()) if (p.title().toLowerCase().contains(t.toLowerCase())) return p;
		return null;
	}

	public boolean hasSite() {
		return !config.siteBase().isEmpty();
	}

	/** Re-reads the site in the background; onChange runs on the caller's thread of choice when the list changed. */
	public void refresh(Consumer<Runnable> runOnServer, Runnable onChange) {
		if (!hasSite() || fetching) return;
		fetching = true;
		HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(config.siteBase() + "/api/pois")).timeout(Duration.ofSeconds(20)).GET();
		if (!config.adminToken.isBlank()) req.header("X-Admin-Token", config.adminToken.trim());
		HTTP.sendAsync(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).whenComplete((res, err) -> {
			fetching = false;
			if (err != null) {
				LanQuick.LOGGER.warn("Places: the site did not answer ({})", err.getMessage());
				return;
			}
			if (res.statusCode() != 200) {
				LanQuick.LOGGER.warn("Places: the site answered {} (check siteUrl and adminToken in lanquick.json)", res.statusCode());
				return;
			}
			List<Place> parsed;
			try {
				parsed = parse(res.body());
			} catch (RuntimeException e) {
				LanQuick.LOGGER.warn("Places: could not read the site's answer: {}", e.getMessage());
				return;
			}
			runOnServer.accept(() -> {
				boolean changed;
				synchronized (this) {
					site = parsed;
					String sig = all().toString();
					changed = !sig.equals(lastSignature);
					lastSignature = sig;
				}
				if (changed) onChange.run();
			});
		});
	}

	static List<Place> parse(String body) {
		JsonObject root = JsonParser.parseString(body).getAsJsonObject();
		JsonArray pois = root.getAsJsonArray("pois");
		List<Place> out = new ArrayList<>();
		if (pois == null) return out;
		for (JsonElement e : pois) {
			JsonObject o = e.getAsJsonObject();
			String title = str(o, "title");
			if (title.isEmpty()) continue;
			out.add(new Place(title, str(o, "type"), num(o, "x"), num(o, "y"), num(o, "z"), str(o, "dim").isEmpty() ? "overworld" : str(o, "dim")));
		}
		return out;
	}

	private static String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e == null || e.isJsonNull() ? "" : e.getAsString();
	}

	private static int num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e == null || e.isJsonNull() ? 0 : (int) Math.floor(e.getAsDouble());
	}

	/** Adds a place. With a site: POST /api/pois and refresh; without: the local file. The callback gets an error text or null. */
	public void mark(Place place, String by, Consumer<Runnable> runOnServer, Consumer<String> done) {
		if (!hasSite()) {
			synchronized (this) {
				local.removeIf(p -> p.title().equalsIgnoreCase(place.title()));
				local.add(place);
				saveLocal();
			}
			done.accept(null);
			return;
		}
		JsonObject body = new JsonObject();
		body.addProperty("title", place.title());
		body.addProperty("type", place.type());
		body.addProperty("x", place.x());
		body.addProperty("y", place.y());
		body.addProperty("z", place.z());
		body.addProperty("dim", place.dim());
		body.addProperty("by", by);
		HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(config.siteBase() + "/api/pois")).timeout(Duration.ofSeconds(20))
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8));
		if (!config.adminToken.isBlank()) req.header("X-Admin-Token", config.adminToken.trim());
		HTTP.sendAsync(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).whenComplete((res, err) -> runOnServer.accept(() -> {
			if (err != null) done.accept("the site did not answer: " + err.getMessage());
			else if (res.statusCode() >= 300) done.accept("the site answered " + res.statusCode());
			else done.accept(null);
		}));
	}

	private void loadLocal() {
		if (!Files.exists(localFile)) return;
		try {
			List<Place> list = GSON.fromJson(Files.readString(localFile), new TypeToken<List<Place>>() {}.getType());
			if (list != null) local = new ArrayList<>(list);
		} catch (IOException | RuntimeException e) {
			LanQuick.LOGGER.warn("lanquick-places.json could not be read: {}", e.getMessage());
		}
	}

	private void saveLocal() {
		try {
			Files.createDirectories(localFile.getParent());
			Files.writeString(localFile, GSON.toJson(local));
		} catch (IOException e) {
			LanQuick.LOGGER.warn("lanquick-places.json could not be written: {}", e.getMessage());
		}
	}

	public synchronized void forceChanged() {
		lastSignature = "";
	}
}
