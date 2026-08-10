import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";

export async function copyToClipboard(
  text: string,
  label: string,
): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    console.log("Copied:", `${label} copied to clipboard`);
    return true;
  } catch (error) {
    console.error("Clipboard error:", error);
    console.error("Error: Failed to copy to clipboard");
    return false;
  }
}

// Amount formatting lives in `./tokenAmount` (no expo imports, so it is
// unit-testable); re-exported here because most call sites import it
// from this module.
export { formatExactTokenAmount, formatTokenAmount } from "./tokenAmount";

export const generateAPIUrl = (relativePath: string) => {
  const origin = Constants.experienceUrl.replace("exp://", "http://");

  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

  if (process.env.NODE_ENV === "development") {
    return origin.concat(path);
  }

  if (!process.env.EXPO_PUBLIC_API_BASE_URL) {
    throw new Error(
      "EXPO_PUBLIC_API_BASE_URL environment variable is not defined",
    );
  }

  return process.env.EXPO_PUBLIC_API_BASE_URL.concat(path);
};
