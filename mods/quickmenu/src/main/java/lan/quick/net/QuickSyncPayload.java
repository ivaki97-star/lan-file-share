package lan.quick.net;

import lan.quick.Place;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

import java.util.ArrayList;
import java.util.List;

/** Server -> client: everything the menu shows. Sent on join, when the places change, and on request. */
public record QuickSyncPayload(List<Place> places, boolean canUse, boolean hasHome, boolean hasDeath, int animalsRadius, double[] boatSpeeds) implements CustomPacketPayload {
	public static final Type<QuickSyncPayload> TYPE = new Type<>(Identifier.fromNamespaceAndPath("lanquick", "sync"));
	public static final StreamCodec<RegistryFriendlyByteBuf, QuickSyncPayload> CODEC = StreamCodec.of(QuickSyncPayload::write, QuickSyncPayload::read);

	private static void write(RegistryFriendlyByteBuf buf, QuickSyncPayload p) {
		buf.writeVarInt(p.places.size());
		for (Place place : p.places) place.write(buf);
		buf.writeBoolean(p.canUse);
		buf.writeBoolean(p.hasHome);
		buf.writeBoolean(p.hasDeath);
		buf.writeVarInt(p.animalsRadius);
		buf.writeVarInt(p.boatSpeeds.length);
		for (double s : p.boatSpeeds) buf.writeDouble(s);
	}

	private static QuickSyncPayload read(RegistryFriendlyByteBuf buf) {
		int n = buf.readVarInt();
		List<Place> places = new ArrayList<>(n);
		for (int i = 0; i < n; i++) places.add(Place.read(buf));
		boolean canUse = buf.readBoolean();
		boolean hasHome = buf.readBoolean();
		boolean hasDeath = buf.readBoolean();
		int radius = buf.readVarInt();
		int m = buf.readVarInt();
		double[] speeds = new double[m];
		for (int i = 0; i < m; i++) speeds[i] = buf.readDouble();
		return new QuickSyncPayload(places, canUse, hasHome, hasDeath, radius, speeds);
	}

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return TYPE;
	}
}
