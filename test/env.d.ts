declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		STELLAR_PAY_TO: string;
		FACILITATOR_URL: string;
	}
}
