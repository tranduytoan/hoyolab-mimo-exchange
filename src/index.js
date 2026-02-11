/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx) {
		return new Response('Hello World!');
	},

	async scheduled(event, env, ctx) {
		const VERSION_ID = Number(env.VERSION_ID);
		const LIST_URL = `https://sg-public-api.hoyolab.com/event/e2023mimotravel/qiuqiu/exchange_list?game_id=2&version_id=${VERSION_ID}&lang=vi-vn`;
		const EXCHANGE_URL = 'https://sg-public-api.hoyolab.com/event/e2023mimotravel/qiuqiu/exchange';
		const TARGET_AWARD = Number(env.TARGET_AWARD);
		const DISCORD_WEBHOOK_URL = env.DISCORD_WEBHOOK_URL || '';
		const USER_STATS_API_URL = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=hk4e_global";


		const headers = {
			'Cookie': env.HOYOLAB_COOKIE || '',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'Content-Type': 'application/json'
		};

		function sleepSeconds(s) {
			return new Promise((r) => setTimeout(r, s * 1000));
		}

		async function fetchList() {
			const res = await fetch(LIST_URL, { headers });
			if (!res.ok) throw new Error(`List request failed. Response status: ${res.status}`);
			return res.json();
		}

		async function callExchangeWithRetries() {
			const maxRetries = 5;
			let json = null;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				const body = JSON.stringify({ game_id: 2, version_id: VERSION_ID, lang: 'vi-vn', award_id: TARGET_AWARD });
				const res = await fetch(EXCHANGE_URL, { method: 'POST', headers, body });

				if (res.status === 429) {
					if (attempt < maxRetries) {
						const delay = Math.pow(2, attempt - 1); // 1,2,4,8,... seconds
						await sleepSeconds(delay);
						continue;
					}
					console.log('All retries exhausted, still rate limited');
					return json;
				}

				try { json = await res.json(); } catch (e) { console.log('Exchange: invalid json', e); }

				// error from server's overload -> keep trying until the error disappears.
				if (json && json.message && json.message.includes("Lỗi mạng, vui lòng thử lại sau~")) {
					await sleepSeconds(1);
					attempt--; // retry without incrementing attempt
					continue;
				}

				if (json && json.retcode === 0) {
					console.log('Exchange success', json);
					await sendDiscordMessage(`Exchange success: ${JSON.stringify(json)}`);
					return json;
				}

				// If Out of stock, retry with increasing delay (for cases where stock has not been reset yet)
				if (json && (json.retcode === -502006 || (json.message && json.message.toLowerCase().includes('Out of stock')))) {
					console.log(`Attempt ${attempt} received Out of stock`);
					if (attempt < maxRetries) {
						const delay = Math.pow(2, attempt - 1); // 1,2,4,8,... seconds
						await sleepSeconds(delay);
						continue;
					}
					console.log('All retries exhausted, still Out of stock');
					sendDiscordMessage('Exchange failed: Out of stock after multiple retries');
					return json;
				}

				// Other failure
				console.log('Exchange failed', json || res.status);
				await sendDiscordMessage(`Exchange failed: ${JSON.stringify(json) || res.status}`);
				return json;
			}
		}

		async function sendDiscordMessage(content) {
			if (!DISCORD_WEBHOOK_URL) {
				console.log('No Discord webhook URL configured');
				return;
			}
			try {
				let user = null;
				console.log("0");
				try {
					const res = await fetch(USER_STATS_API_URL, { headers });
					console.log(res);
					if (res.ok) {
						const json = await res.json();
						if (json && json.retcode === 0 && json.data && json.data.list && json.data.list.length > 0) {
							user = {
								name: json.data.list[0].nickname || '',
								level: json.data.list[0].level || ''
							};
						} else {
							console.log('Failed to get valid user data from stats API', json);
						}
					}
					console.log("1");
				} catch (e) {
					console.log('Failed to fetch user stats for nickname', e);
				}

				console.log("2");

				const body = {
					content: '',
					username: 'Genshin Auto Bot',
					avatar_url: 'https://genshin.hoyoverse.com/favicon.ico',
					embeds: [
						{
							title: 'Hoyolab Mimo Auto Exchange',
							description: content,
							color: 10066329,
							author: {
								name: user ? user.name : 'Hikane',
								icon_url: 'https://genshin.hoyoverse.com/favicon.ico',
							},
							"fields": [
								{
								"name": "👤 Player Info",
								"value": user ? '**Adventure Rank:** ' + user.level : '**Adventure Rank:** 60',
								"inline": true
								}
							],
							footer: {
								text: 'Genshin Auto Bot',
								icon_url: 'https://genshin.hoyoverse.com/favicon.ico',
							},
							timestamp: new Date().toISOString(),
						},
					],
				};

				const res = await fetch(DISCORD_WEBHOOK_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...body })
				});
				if (!res.ok) {
					console.log('Failed to send Discord message', res.status);
				} else {
					console.log('Discord message sent');
				}
			} catch (e) {
				console.log('Error sending Discord message', e);
			}
		}

		async function getTargetAwardFromListJson(listJson) {
			const message = listJson?.message || '';
			const awards = (listJson && listJson.data && listJson.data.exchange_award_list) || [];
			if (awards.length === 0 && message != '') {
				return { award: null, awardNotFoundMessage: `No awards found in list, response message: ${message}\n` };
			}

			const award = awards.find((a) => a.award_id === TARGET_AWARD);
			if (!award) {
				return { award: null, awardNotFoundMessage: 'Target award not found in list\n' };
			}
			return { award: award, awardNotFoundMessage: null };
		}


		// Main flow: b1 / b2 loop
		let attemptsForWait = 0;
		const maxWaitAttempts = 5;
		while (attemptsForWait < maxWaitAttempts) {
			let listJson = null;
			try {
				listJson = await fetchList();

				// error from server's overload -> keep trying until the error disappears.
				if (listJson.message && listJson.message.includes("Lỗi mạng, vui lòng thử lại sau~")) {
					await sleepSeconds(1);
					continue; // retry without incrementing attemptsForWait
				}
			} catch (e) {
				// A rate limit means that exchange time is approaching (so many users are checking), try to exchange directly
				if (e.message && e.message.includes('429')) {
					console.log('Rate limited when fetching list, trying to exchange...');
					await callExchangeWithRetries();
					continue; // retry b1 but dont increment attemptsForWait
				}
				const logMessage = `${e.message || e}\n`;
				console.log(logMessage);
				await sendDiscordMessage('Get list award failed:\n' + logMessage);
				return;
			}

			const {award, awardNotFoundMessage} = await getTargetAwardFromListJson(listJson);
			if (!award) {
				console.log(awardNotFoundMessage);
				await sendDiscordMessage('Get award-info failed:\n' + awardNotFoundMessage);
				return;
			}

			const stock = Number(award.stock || 0);
			const nextRefresh = Number(award.next_refresh_time || 0); // seconds
			console.log(`Award: ${award.name || TARGET_AWARD} { ${stock}, ${nextRefresh} }`);

			// b1
			if (stock > 0 || (stock === 0 && nextRefresh === 0)) {
				console.log('Condition met to call exchange (b1)');
				await callExchangeWithRetries();
				return;
			}

			// b2: stock = 0 and next_refresh_time != 0
			if (stock === 0 && nextRefresh !== 0) {
				if (nextRefresh < 600) {
					console.log(`Waiting ${nextRefresh}s before retrying (b2)`);
					await sleepSeconds(nextRefresh);
					attemptsForWait++;
					continue; // quay lại b1
				}
				const logMessage = `Next_refresh_time >= 600s (${nextRefresh}s), skipping wait and stopping\n`;
				console.log(logMessage);
				await sendDiscordMessage('Exchange skipped:\n' + logMessage);
				return;
			}

			// fallback
			console.log('No action taken');
			return;
		}
	}
};
