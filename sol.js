const axios = require('axios');

/**
 * Fetches the floor price of a Solana NFT collection from Magic Eden by collection ID.
 * @param {string} collectionId - The ID of the NFT collection on Magic Eden.
 */
async function getFloorPrice(collectionId) {
    const url = `https://api-mainnet.magiceden.dev/v2/collections/${collectionId}/stats`;

    try {
        const response = await axios.get(url);
        const floorPriceLamports = response.data.floorPrice || 0;
        
        // Convert Lamports to SOL (1 SOL = 1,000,000,000 Lamports)
        const floorPriceSol = floorPriceLamports / 1_000_000_000;
        
        console.log(`✅ Floor Price for '${collectionId}': ${floorPriceSol.toFixed(2)} SOL`);
        return floorPriceSol;
    } catch (error) {
        console.error("❌ Error fetching floor price:", error.message);
        return null;
    }
}

// ✅ Example Usage:
const collectionId = "okay_bears"; // Replace with your desired collection ID
getFloorPrice(collectionId);
