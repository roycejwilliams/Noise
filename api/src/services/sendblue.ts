import { SendblueAPI } from "sendblue";

const sendblue = new SendblueAPI({
  apiKey: process.env.SENDBLUE_API_KEY!,
  apiSecret: process.env.SENDBLUE_SECRET_KEY!,
});

export default sendblue;
