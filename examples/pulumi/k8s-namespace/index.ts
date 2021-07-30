import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

const ns = new k8s.core.v1.Namespace(config.require("namespace"))
export const namespace = ns.metadata.name
