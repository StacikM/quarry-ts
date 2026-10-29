package audit;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Reads registry values from the verified, unmodified 1.8.9 client jar. Does not launch Minecraft.
 * All obfuscated reflection names below are specific to the SHA-1 verified by the runner.
 */
public final class VanillaLightProbe {
    public static void main(String[] args) throws Exception {
        Class<?> blockClass = Class.forName("afh");
        blockClass.getDeclaredMethod("S").invoke(null); // Block.registerBlocks()
        Method byId = blockClass.getDeclaredMethod("c", int.class); // Block.getBlockById(int)
        Field opacity = blockClass.getDeclaredField("s");
        Field emission = blockClass.getDeclaredField("u");
        opacity.setAccessible(true);
        emission.setAccessible(true);
        // Verify the inferred fields against distinct registration/constructor values.
        int[] ids = {0, 1, 9, 18, 50, 11};
        int[] expectedOpacity = {0, 255, 3, 1, 0, 0};
        int[] expectedEmission = {0, 0, 0, 0, 14, 15};
        for (int i = 0; i < ids.length; i++) {
            Object block = byId.invoke(null, ids[i]);
            if (opacity.getInt(block) != expectedOpacity[i] || emission.getInt(block) != expectedEmission[i]) {
                throw new IllegalStateException("Unexpected block field mapping at id " + ids[i]);
            }
        }
        StringBuilder json = new StringBuilder("[");
        for (int id = 0; id <= 197; id++) {
            Object block = byId.invoke(null, id);
            if (id > 0) json.append(',');
            json.append("{\"id\":").append(id)
                .append(",\"opacity\":").append(opacity.getInt(block))
                .append(",\"emission\":").append(emission.getInt(block)).append('}');
        }
        System.out.println("VANILLA_LIGHT_DATA=" + json.append(']'));
    }
}
