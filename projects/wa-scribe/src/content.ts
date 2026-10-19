import { contentHello, panelPing } from "./protocol";
import { reportExchange } from "./report";

reportExchange("#content-ack", contentHello());
reportExchange("#content-wrong-context", panelPing("content-as-panel"));
