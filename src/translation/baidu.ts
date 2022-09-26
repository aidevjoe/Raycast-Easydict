/*
 * @author: tisfeng
 * @createTime: 2022-08-03 10:18
 * @lastEditor: tisfeng
 * @lastEditTime: 2022-09-26 11:02
 * @fileName: baidu.ts
 *
 * Copyright (c) 2022 by tisfeng, All Rights Reserved.
 */

import axios, { AxiosError, AxiosRequestConfig } from "axios";
import CryptoJS from "crypto-js";
import querystring from "node:querystring";
import { requestCostTime } from "../axiosConfig";
import { LanguageDetectType, LanguageDetectTypeResult } from "../detectLanauge/types";
import { QueryWordInfo } from "../dictionary/youdao/types";
import { getBaiduLanguageId, getYoudaoLanguageIdFromBaiduId } from "../language/languages";
import { KeyStore } from "../preferences";
import { BaiduTranslateResult, QueryTypeResult, RequestErrorInfo, TranslationType } from "../types";
import { getTypeErrorInfo } from "../utils";

import genBaiduWebSign, { VolcengineTranslateAPI } from "./baiduSign";

const accessKey = "AKLTY2ZkZjkwYTllN2U0NGJkMWE1MGVhOGI4ZWQzYjE4YzA";
const secretKey = "TnpjeE5qTXdNbVU0Tnpnek5HRTFPVGhrTVRZMlpESTNZamMyTXpkbFl6SQ==";

/**
 * Volcengine Translate API
 */
export async function requestVolcanoTranslate(queryWordInfo: QueryWordInfo) {
  console.log(`---> start request volcanoTranslateAPI`);
  const { fromLanguage, toLanguage, word } = queryWordInfo;

  const volcanoTranslate = VolcengineTranslateAPI(word, accessKey, secretKey, "zh");

  const url = volcanoTranslate.getUrl();
  const params = volcanoTranslate.getParams();
  const config = volcanoTranslate.getConfig();

  axios
    .post(url, params, config)
    .then((res) => {
      console.log(`volcanoTranslateAPI res: ${JSON.stringify(res.data, null, 2)}`);
      console.warn(`cost time: ${res.headers[requestCostTime]} ms`);
    })
    .catch((err) => {
      console.log(`volcanoTranslateAPI err: ${JSON.stringify(err, null, 2)}`);
    });
}

/**
 * Baidu translate. Cost time: ~0.4s
 *
 * 百度翻译API https://fanyi-api.baidu.com/doc/21
 */
export function requestBaiduTextTranslate(queryWordInfo: QueryWordInfo): Promise<QueryTypeResult> {
  console.log(`---> start request Baidu`);

  requestVolcanoTranslate(queryWordInfo);

  const { fromLanguage, toLanguage, word } = queryWordInfo;
  const from = getBaiduLanguageId(fromLanguage);
  const to = getBaiduLanguageId(toLanguage);

  const salt = Math.round(new Date().getTime() / 1000);
  const baiduAppId = KeyStore.baiduAppId;
  const md5Content = baiduAppId + word + salt + KeyStore.baiduAppSecret;
  const sign = CryptoJS.MD5(md5Content).toString();
  const url = "https://fanyi-api.baidu.com/api/trans/vip/translate";
  const encodeQueryText = Buffer.from(word, "utf8").toString();
  const params = {
    q: encodeQueryText,
    from: from,
    to: to,
    appid: baiduAppId,
    salt: salt,
    sign: sign,
  };
  // console.log(`---> Baidu params: ${JSON.stringify(params, null, 4)}`);
  return new Promise((resolve, reject) => {
    axios
      .get(url, { params })
      .then((response) => {
        const baiduResult = response.data as BaiduTranslateResult;
        // console.log(`---> baiduResult: ${JSON.stringify(baiduResult, null, 4)}`);
        if (baiduResult.trans_result) {
          const translations = baiduResult.trans_result.map((item) => item.dst);
          console.warn(`Baidu translate: ${translations}`);
          console.log(`fromLang: ${baiduResult.from}, cost: ${response.headers[requestCostTime]} ms`);
          const result: QueryTypeResult = {
            type: TranslationType.Baidu,
            result: baiduResult,
            translations: translations,
            wordInfo: queryWordInfo,
          };
          resolve(result);
        } else {
          console.error(`baidu translate error: ${JSON.stringify(baiduResult)}`); //  {"error_code":"54001","error_msg":"Invalid Sign"}
          const errorInfo: RequestErrorInfo = {
            type: TranslationType.Baidu,
            code: baiduResult.error_code || "",
            message: baiduResult.error_msg || "",
          };
          reject(errorInfo);
        }
      })
      .catch((error: AxiosError) => {
        if (error.message === "canceled") {
          console.log(`---> baidu canceled`);
          return reject(undefined);
        }

        // It seems that Baidu will never reject, always resolve...
        console.error(`---> baidu translate error: ${error}`);
        const errorInfo = getTypeErrorInfo(TranslationType.Baidu, error);
        reject(errorInfo);
      });
  });
}

/**
 * Baidu language detect. Cost time: ~0.4s
 *
 * Although Baidu provides a dedicated language recognition interface, the number of supported languages is too small, so we directly use Baidu Translate's automatic language recognition instead.
 *
 * 百度语种识别API https://fanyi-api.baidu.com/doc/24
 */
export async function baiduLanguageDetect(text: string): Promise<LanguageDetectTypeResult> {
  console.log(`---> start request Baidu language detect`);

  const queryWordInfo: QueryWordInfo = {
    fromLanguage: "auto",
    toLanguage: "zh",
    word: text,
  };

  try {
    const baiduTypeResult = await requestBaiduTextTranslate(queryWordInfo);
    const baiduResult = baiduTypeResult.result as BaiduTranslateResult;
    const baiduLanaugeId = baiduResult.from || "";
    const youdaoLanguageId = getYoudaoLanguageIdFromBaiduId(baiduLanaugeId);
    console.warn(`---> Baidu detect languageId: ${baiduLanaugeId}, youdaoId: ${youdaoLanguageId}`);

    /**
     * Generally speaking, Baidu language auto-detection is more accurate than Tencent language recognition.
     * Baidu language recognition is inaccurate in very few cases, such as "ragazza", it should be Italian, but Baidu auto detect is en.
     * In this case, trans_result's src === dst.
     */
    let confirmed = false;
    const transResult = baiduResult.trans_result;
    if (transResult?.length) {
      const firstTransResult = transResult[0];
      confirmed = firstTransResult.dst !== firstTransResult.src;
    }
    const detectedLanguageResult: LanguageDetectTypeResult = {
      type: LanguageDetectType.Baidu,
      sourceLanguageId: baiduLanaugeId,
      youdaoLanguageId: youdaoLanguageId,
      confirmed: confirmed,
      result: baiduResult,
    };
    return Promise.resolve(detectedLanguageResult);
  } catch (error) {
    const errorInfo = error as RequestErrorInfo | undefined;
    if (errorInfo) {
      console.error(`---> baidu language detect error: ${JSON.stringify(error)}`);
      errorInfo.type = LanguageDetectType.Baidu; // * Note: need to set language detect type.
    }
    return Promise.reject(errorInfo);
  }
}

export function requestBaiduWebTranslate(queryWordInfo: QueryWordInfo) {
  console.log(`---> start request Baidu web`);
  const { fromLanguage, toLanguage, word } = queryWordInfo;
  const from = getBaiduLanguageId(fromLanguage);
  const to = getBaiduLanguageId(toLanguage);

  const sign = genBaiduWebSign(word);
  console.log("genBaiduWebSign:", sign);

  const data = {
    from: from,
    to: to,
    query: word,
    transtype: "realtime",
    simple_means_flag: "3",
    sign: sign, // "262931.57378"
    token: "d29164d8e5ad8982b8bdfebb302b1d02",
    domain: "common",
  };

  const url = `https://fanyi.baidu.com/v2transapi?from=${from}&to=${to}`;
  // console.log("url:", url);
  // console.log(`data: ${JSON.stringify(data, null, 4)}`);

  const config: AxiosRequestConfig = {
    method: "post",
    url,
    headers: {
      Cookie: `BDUSS_BFESS=ZyaElxRFNualBCTDBiaUpuZThZRElJVHNXLU51Ymsyc0IwTWR6Q05QU28yOUJpRVFBQUFBJCQAAAAAAAAAAAEAAACFn5wyus3Jz7Xb1sD3u9fTMjkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKhOqWKoTqliR0; BIDUPSID=6EB71D1B4A8BC0DE40363496E6DB1F13; PSTM=1655978669; BAIDUID=6EB71D1B4A8BC0DE40363496E6DB1F13:SL=0:NR=10:FG=1; delPer=0; ZFY=AEhZxlaGqYfzFMBYtyymV:BcseeQ0ZORDMeQ:Aov9aKEs:C; H_PS_PSSID=36553_36464_36502_36455_31254_36667_36413_36691_36167_36694_36698_26350_36468_36312; BDRCVFR[feWj1Vr5u3D]=I67x6TjHwwYf0; APPGUIDE_10_0_2=1; REALTIME_TRANS_SWITCH=1; FANYI_WORD_SWITCH=1; HISTORY_SWITCH=1; SOUND_SPD_SWITCH=1; SOUND_PREFER_SWITCH=1; Hm_lvt_64ecd82404c51e03dc91cb9e8c025574=1660230940; BAIDUID_BFESS=6EB71D1B4A8BC0DE40363496E6DB1F13:SL=0:NR=10:FG=1; H_WISE_SIDS=110085_131862_189755_194529_196427_197471_204427_204906_209568_210322_211435_211986_212296_212873_213029_213349_214800_215730_216211_216942_219473_219558_219623_219723_219744_219942_219946_220017_220072_220604_220606_220662_220855_220928_221121_221318_221410_221468_221479_221502_221550_221678_221697_221874_221916_222207_222298_222396_222443_222522_222625_222887_223192_223209_223228_223374_223474_223683_223769_223789_223889_224045_224055_224099_224195_224429_224457_224573_224812_224914_224983_225245_225297_225337_225383_225661_225743_225755_225859_225917_225983_226011_226075_226218_226284_226294_226377_226388_226405_226431_226504_226509_226545_226574_226719_226757_226867_227061_227064_227066_227082_227156_227215_227367_8000081_8000105_8000126_8000140_8000149_8000154_8000171_8000177_8000179_8000186; RT="z=1&dm=baidu.com&si=s0cbuhw4hc&ss=l7pk6fr5&sl=3&tt=3js&bcn=https%3A%2F%2Ffclog.baidu.com%2Flog%2Fweirwood%3Ftype%3Dperf&ld=197e&ul=1ldt&hd=1lel"; Hm_lvt_afd111fa62852d1f37001d1f980b6800=1662567262; Hm_lpvt_afd111fa62852d1f37001d1f980b6800=1662568745; Hm_lpvt_64ecd82404c51e03dc91cb9e8c025574=1662569824`,
    },
    data: querystring.stringify(data), // if data is json object ??
    // data: data,
  };

  axios(config)
    .then(function (response) {
      console.log(`---> request Baidu web success: ${JSON.stringify(response.data, null, 2)}`);
      console.log(`baidu web cost: ${response.headers[requestCostTime]}`);
    })
    .catch(function (error) {
      console.error(`---> request Baidu web error: ${JSON.stringify(error)}`);
    });
}
