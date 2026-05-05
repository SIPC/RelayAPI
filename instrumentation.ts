export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeWebAccessKey } =
      await import("./src/server/services/webAccess");
    initializeWebAccessKey();
  }
}
