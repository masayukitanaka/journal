import { DurableObject } from "cloudflare:workers";

// 外部 API 呼び出しを直列化するレート制御（ARCHITECT.md 3.3）。
// 呼び出し元は /reserve を叩き、「いつ呼び出してよいか」を予約してから実際の fetch を行う。
// DO は単一インスタンス（シングルトン、固定名で idFromName）として扱う前提。
abstract class RateLimiter extends DurableObject<Env> {
	// 秒間リクエスト数の上限。サブクラスで上書きする。
	protected abstract readonly requestsPerSecond: number;

	private nextAvailableAt(): Promise<number> {
		return this.ctx.storage.get<number>("nextAvailableAt").then((v) => v ?? 0);
	}

	// 1 件分の呼び出し権を予約し、呼び出し可能になるまでの待機時間（ms）を返す。
	async reserve(): Promise<{ waitMs: number }> {
		const intervalMs = 1000 / this.requestsPerSecond;
		const now = Date.now();
		const current = await this.nextAvailableAt();
		const scheduled = Math.max(now, current);
		await this.ctx.storage.put("nextAvailableAt", scheduled + intervalMs);
		return { waitMs: Math.max(0, scheduled - now) };
	}

	// 429 応答を受けた場合、次に呼び出し可能な時刻を指定の ms だけ後ろに延長する。
	async extendBackoff(extraMs: number): Promise<void> {
		const current = await this.nextAvailableAt();
		await this.ctx.storage.put("nextAvailableAt", Math.max(current, Date.now()) + extraMs);
	}

	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	}
}

export class RateLimiterOpenAlex extends RateLimiter {
	// 無料 API キー利用時の秒間リクエスト数上限（ARCHITECT.md 6章、P1-2 で実測し調整する）。
	protected readonly requestsPerSecond = 30;
}

export class RateLimiterSemanticScholar extends RateLimiter {
	// API キーあり利用時の初期値（ARCHITECT.md 3.3）。
	protected readonly requestsPerSecond = 1;
}
