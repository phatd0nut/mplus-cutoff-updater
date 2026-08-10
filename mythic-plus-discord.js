const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCESS_KEY = process.env.RAIDER_IO_ACCESS_KEY;
const REGION = 'eu'; // Change this to your desired region (e.g., 'us', 'eu', 'kr', 'tw', 'cn')
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
// 10 = The War Within. Safe historical floor to start probing from — raising
// it just saves a couple of requests, it's never required for correctness.
const EXPANSION_ID_FLOOR = Number(process.env.EXPANSION_ID_FLOOR || '10');
const STATE_FILE = path.join(__dirname, 'last-cutoff.json');

if (!ACCESS_KEY) {
    console.error('Missing RAIDER_IO_ACCESS_KEY environment variable.');
    process.exit(1);
}

if (!WEBHOOK_URL) {
    console.error('Missing DISCORD_WEBHOOK_URL environment variable.');
    process.exit(1);
}

// Raider.IO has no "current season"/"current expansion" endpoint. An unknown
// expansion_id just returns an empty seasons list, so we probe upward from
// the floor until that happens, which also picks up future expansions
// automatically without ever needing to bump EXPANSION_ID_FLOOR.
async function getCurrentSeasonSlug() {
    const now = new Date();
    let currentSeason = null;

    for (let expansionId = EXPANSION_ID_FLOOR; ; expansionId++) {
        const staticDataUrl = `https://raider.io/api/v1/mythic-plus/static-data?access_key=${ACCESS_KEY}&expansion_id=${expansionId}`;
        const staticData = JSON.parse(await makeHttpsRequest(staticDataUrl));

        if (!staticData.seasons || staticData.seasons.length === 0) break;

        const match = staticData.seasons.find(season =>
            season.is_main_season &&
            now >= new Date(season.starts[REGION]) &&
            now <= new Date(season.ends[REGION])
        );
        if (match) currentSeason = match.slug;
    }

    if (!currentSeason) {
        throw new Error('Could not determine the current mythic+ season');
    }

    return currentSeason;
}

async function sendMythicPlusCutoffToDiscord() {
    try {
        // Fetch data from Raider.IO API
        const season = await getCurrentSeasonSlug();
        const apiUrl = `https://raider.io/api/v1/mythic-plus/season-cutoffs?access_key=${ACCESS_KEY}&season=${season}&region=${REGION}`;

        const apiData = await makeHttpsRequest(apiUrl);
        const response = JSON.parse(apiData);
        const cutoffs = response.cutoffs;
        console.log(response)

        // Extract p999 (Top 0.1%) and p990 (Top 1%) data
        const p999Data = cutoffs.p999.all;
        const p990Data = cutoffs.p990.all;
        const region = cutoffs.region.name;
        const updatedAt = cutoffs.updatedAt;

        const lastSeenUpdatedAt = readLastSeenUpdatedAt();
        if (lastSeenUpdatedAt === updatedAt) {
            console.log(`No new score yet (still ${updatedAt}) — skipping Discord notification.`);
            return;
        }

        // Build Discord embed payload
        const discordPayload = {
            embeds: [{
                title: "Mythic+ Cutoffs Update",
                color: 7506394,
                fields: [
                    { name: "🌍 Region", value: region, inline: true },
                    { name: "🏆 Top 0.1% Score", value: p999Data.quantileMinValue.toFixed(2), inline: true },
                    { name: "🥈 Top 1% Score", value: p990Data.quantileMinValue.toFixed(2), inline: true },
                    { name: "👥 Top 0.1% Population", value: p999Data.quantilePopulationCount.toLocaleString(), inline: true },
                    { name: "👥 Top 1% Population", value: p990Data.quantilePopulationCount.toLocaleString(), inline: true },
                    { name: "📊 Total Population", value: p999Data.totalPopulationCount.toLocaleString(), inline: true },
                    { name: "🕐 Last Updated", value: updatedAt, inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "Raider.IO Mythic+ Cutoffs" }
            }]
        };

        // Send to Discord
        await sendToDiscord(WEBHOOK_URL, discordPayload);
        writeLastSeenUpdatedAt(updatedAt);
        console.log("✅ Discord webhook notification sent successfully!");
        console.log(`Top 0.1%: ${p999Data.quantileMinValue.toFixed(2)} | Top 1%: ${p990Data.quantileMinValue.toFixed(2)} | Region: ${region}`);

    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    }
}

function readLastSeenUpdatedAt() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).updatedAt;
    } catch (error) {
        return null;
    }
}

function writeLastSeenUpdatedAt(updatedAt) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt }, null, 2));
}

// Helper function to make HTTPS GET requests
function makeHttpsRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// Helper function to send POST request to Discord
function sendToDiscord(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
        const url = new URL(webhookUrl);
        const postData = JSON.stringify(payload);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`Discord API returned status ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

sendMythicPlusCutoffToDiscord();