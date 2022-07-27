import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import fetch from "node-fetch";
import {Markup, Telegraf} from "telegraf";
import {InlineKeyboardMarkup} from "telegraf/typings/core/types/typegram";
import QuerySnapshot = admin.firestore.QuerySnapshot;

import {Listing, SearchEntry} from "./types";
import {sleep} from "./utils";

admin.initializeApp();

const firestore = admin.firestore();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN as string);

// noinspection JSUnusedGlobalSymbols
export const checkListings = functions
    .region("europe-west3")
    .runWith({
      timeoutSeconds: 540,
      maxInstances: 1,
      memory: "128MB",
      secrets: ["TELEGRAM_TOKEN", "AIRBNB_API_KEY"],
    })
    .pubsub.schedule("every 5 minutes")
    .onRun(async () => {
      const snapshot = await firestore.collection("searches")
          .where("active", "==", true)
          .get() as QuerySnapshot<SearchEntry>;

      for (const [index, searchSnapshot] of snapshot.docs.entries()) {
        if (index !== 0) await sleep(15000);

        const search = searchSnapshot.data();
        const knownListingIds = search.knownListings ?? [];
        const listings = await loadListings(search);
        const newListings = listings.filter((item) => !knownListingIds.includes(item.id));

        functions.logger.info(`Total listings: ${listings.length}, new listings: ${newListings.length}`);

        for (const [i, listing] of newListings.entries()) {
          if (i !== 0) await sleep(3000);

          functions.logger.info(`Processing listing ${listing.id}`, listing);
          await sendTelegramMessage(listing, search);
        }

        await searchSnapshot.ref.update({
          knownListings: listings.map((item) => item.id),
        });
      }
    });

async function loadListings(search: SearchEntry): Promise<Listing[]> {
  const url = "https://www.airbnb.com/api/v3/ExploreSections";
  const headers = {
    "X-Airbnb-API-Key": process.env.AIRBNB_API_KEY as string,
  };
  const queryParams = {
    operationName: "ExploreSections",
    locale: "en",
    currency: search.currency,
    variables: JSON.stringify({
      exploreRequest: {
        metadataOnly: false,
        version: "1.8.3",
        itemsPerGrid: 40,
        refinementPaths: ["/homes"],
        ...search.filters,
      },
    }),
    extensions: JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash: "a4f62dd4a0c881ddc9a3a00bc376e15c3fd1b10e6bc0a7c38d48f048a20b6c17",
      },
    }),
  };
  const queryParamsString = new URLSearchParams(queryParams).toString();

  const resp = await fetch(url + "?" + queryParamsString, {headers});
  const sections = (await resp.json())?.data?.presentation?.explore?.sections?.sections ?? [];
  for (const section of sections) {
    if (section.section?.child?.section?.__typename === "ExploreListingsSection") {
      const items = section.section.child?.section?.items ?? [];
      return items.map((item: any): Listing => ({
        id: item.listing.id as string,
        name: item.listing.name as string,
        imageUrl: item.listing.contextualPictures?.map((picture: any) => picture.picture)?.[0] as string | null,
        rating: item.listing.avgRatingLocalized ?? item.listing.avgRating,
        price: {
          total: item.pricingQuote.structuredStayDisplayPrice.secondaryLine.accessibilityLabel,
          nightly: item.pricingQuote.structuredStayDisplayPrice.primaryLine.accessibilityLabel,
        },
        rawResponse: item,
      }));
    }
  }
  throw new Error("Unable to find listings");
}

function getRoomUrl(id: string, search: SearchEntry) {
  const queryParams = new URLSearchParams({
    currency: search.currency,
    check_in: search.filters.checkin,
    check_out: search.filters.checkout,
    adults: search.filters.adults.toString(),
  }).toString();

  return `https://www.airbnb.com/rooms/${id}?${queryParams}`;
}

async function sendTelegramMessage(listing: Listing, search: SearchEntry) {
  const url = getRoomUrl(listing.id, search);
  const messageLines = [
    `<b><a href="${url}">${listing.name}</a></b>`,
    "",
    `💰 <b>${listing.price.total}</b> (${listing.price.nightly})`,
    `⭐️ ${listing.rating ?? "No rating"}`,
  ];
  const message = messageLines.join("\n");

  const inlineKeyboardMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [Markup.button.url("Open in Airbnb", url)],
    ],
  };

  if (listing.imageUrl) {
    await bot.telegram.sendPhoto(search.chatId, listing.imageUrl, {
      caption: message,
      parse_mode: "HTML",
      reply_markup: inlineKeyboardMarkup,
    });
  } else {
    await bot.telegram.sendMessage(search.chatId, message, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboardMarkup,
    });
  }
}
