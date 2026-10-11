package lan.quick.client;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;

/** A square button that shows an item instead of text. The text stays as its message, for narration and tests. */
public class IconButton extends Button {
	private final ItemStack icon;
	public boolean selected;

	public IconButton(int x, int y, int size, Component label, ItemStack icon, OnPress onPress) {
		super(x, y, size, size, label, onPress, DEFAULT_NARRATION);
		this.icon = icon;
		setTooltip(Tooltip.create(label));
	}

	@Override
	protected void extractContents(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		extractDefaultSprite(graphics);
		if (selected) graphics.fill(getX() + 1, getY() + 1, getX() + getWidth() - 1, getY() + getHeight() - 1, 0x60FFFFFF);
		graphics.item(icon, getX() + (getWidth() - 16) / 2, getY() + (getHeight() - 16) / 2);
	}
}
