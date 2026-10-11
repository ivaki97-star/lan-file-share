package lan.quick.client.mixin;

import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Where the inventory window really is: the recipe book pushes it to the right, so the centre is not enough. */
@Mixin(AbstractContainerScreen.class)
public interface ContainerScreenAccessor {
	@Accessor("leftPos")
	int lanquick$leftPos();

	@Accessor("topPos")
	int lanquick$topPos();

	@Accessor("imageWidth")
	int lanquick$imageWidth();

	@Accessor("imageHeight")
	int lanquick$imageHeight();
}
