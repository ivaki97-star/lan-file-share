package lan.quick.net;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** Client -> server: "send me the menu data again" (the inventory was opened). */
public record QuickRequestPayload() implements CustomPacketPayload {
	public static final QuickRequestPayload INSTANCE = new QuickRequestPayload();
	public static final Type<QuickRequestPayload> TYPE = new Type<>(Identifier.fromNamespaceAndPath("lanquick", "request"));
	public static final StreamCodec<RegistryFriendlyByteBuf, QuickRequestPayload> CODEC = StreamCodec.of((buf, p) -> {}, buf -> INSTANCE);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return TYPE;
	}
}
