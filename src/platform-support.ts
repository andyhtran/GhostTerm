export interface GhostTermPlatformSupport {
	readonly supported: boolean;
	readonly reason?: string;
}

export function currentPlatformSupport(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): GhostTermPlatformSupport {
	if (platform !== "darwin") {
		return {
			supported: false,
			reason: "GhostTerm currently supports macOS on Apple Silicon."
		};
	}
	if (arch !== "arm64") {
		return {
			supported: false,
			reason: "GhostTerm currently requires an Apple Silicon Mac."
		};
	}
	return { supported: true };
}
