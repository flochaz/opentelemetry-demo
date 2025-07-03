import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

import { Construct } from 'constructs';

// Global domain name constant
const DOMAIN_NAME = 'opentelemetry-demo.local';

type DemoService = {
  name: string;
  port: number;
  domain: string;
  service: ecs.FargateService | ecsPatterns.ApplicationLoadBalancedFargateService;
};

export class AwsEcsCdkStack extends cdk.Stack {
  private vpc: ec2.Vpc;
  private cluster: ecs.Cluster;
  private services: Map<string, ecs.FargateService | ecsPatterns.ApplicationLoadBalancedFargateService> = new Map();

  // Removed dedicated security groups for valkey and cart

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC
    this.vpc = new ec2.Vpc(this, 'OpenTelemetryDemoVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Create a task execution role with CloudWatch Logs permissions
    this.ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    // Add explicit CloudWatch Logs permissions (in case)
    this.ecsTaskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:CreateLogGroup',
      ],
      resources: ['*'],
    }));

    // No dedicated security groups for valkey and cart; all services get their own SG with open inbound on their ports

    // Create ECS Cluster
    this.cluster = new ecs.Cluster(this, 'OpenTelemetryDemoCluster', {
      vpc: this.vpc,
      containerInsights: true,
      defaultCloudMapNamespace: {
        name: DOMAIN_NAME,
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
      },
    });

        // Create telemetry services
    const {otelCollector, prometheus, grafana, jaeger} = this.createTelemetryServices();


    // Create core demo services
    this.createCoreServices({otelCollector, prometheus, grafana, jaeger,});


  }

  private createCoreServices({
    otelCollector,
    prometheus,
    grafana,
    jaeger,
  }: {
    otelCollector: DemoService;
    prometheus: DemoService;
    grafana: DemoService;
    jaeger: DemoService;
  }) {

    // Flagd (feature flagging service)
    const flagd = this.createService('flagd', {
      image: 'ghcr.io/open-feature/flagd:v0.12.5',
      port: 8013,
      cpu: 256,
      memory: 512,
      environment: {
        FLAGD_OTEL_COLLECTOR_URI: `${otelCollector.domain}:${otelCollector.port}`,
        FLAGD_METRICS_EXPORTER: 'otel',
        GOMEMLIMIT: '60MiB',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'flagd',
      }
    });

        // Flagd UI
    const flagdUi = this.createService('flagd-ui', {
      image: 'ghcr.io/open-telemetry/demo:latest-flagd-ui',
      port: 4000,
      cpu: 256,
      memory: 512,
      environment: {}
    });


    // OpenSearch as ECS service (from .env)
    const opensearch = this.createService('opensearch', {
      image: 'opensearchproject/opensearch:3.1.0',
      port: 9200,
      cpu: 1024,
      memory: 2048,
      environment: {
        'cluster.name': 'demo-cluster',
        'node.name': 'demo-node',
        'bootstrap.memory_lock': 'true',
        'discovery.type': 'single-node',
        'OPENSEARCH_JAVA_OPTS': '-Xms300m -Xmx300m',
        'DISABLE_INSTALL_DEMO_CONFIG': 'true',
        'DISABLE_SECURITY_PLUGIN': 'true',
      }
    });

    const valkeyCart = this.createService('valkey-cart', {
      image: 'valkey/valkey:7.2-alpine',
      port: 6379,
      cpu: 256,
      memory: 512,
      environment: {},
    });
    const ad = this.createService('ad', {
      image: 'ghcr.io/open-telemetry/demo:latest-ad',
      port: 9555,
      cpu: 256,
      memory: 512,
      environment: {
        AD_PORT: '9555',
        FLAGD_HOST: flagd.domain,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://otel-collector.${DOMAIN_NAME}:4318`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_SERVICE_NAME: 'ad',
        _JAVA_OPTIONS: '',
      }
    });

    // Cart Service
    const cart = this.createService('cart', {
      image: 'ghcr.io/open-telemetry/demo:latest-cart',
      port: 7070,
      cpu: 256,
      memory: 512,
      environment: {
        CART_PORT: '7070',
        FLAGD_HOST: flagd.domain,
        VALKEY_ADDR: `${valkeyCart.domain}:${valkeyCart.port}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'cart',
        ASPNETCORE_URLS: 'http://*:7070',
      }
    });

    // Currency Service
    const currency = this.createService('currency', {
      image: 'ghcr.io/open-telemetry/demo:latest-currency',
      port: 7001,
      cpu: 256,
      memory: 512,
      environment: {
        CURRENCY_PORT: '7001',
        VERSION: '2.0.2',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2,service.name=currency',
        // Do NOT set OTEL_SERVICE_NAME, as the C++ SDK does not support it
      }
    });

    // Email Service
    const email = this.createService('email', {
      image: 'ghcr.io/open-telemetry/demo:latest-email',
      port: 6060,
      cpu: 256,
      memory: 512,
      environment: {
        APP_ENV: 'production',
        EMAIL_PORT: '6060',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://otel-collector.${DOMAIN_NAME}:4318/v1/traces`,
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'email',
      }
    });

    // Product Catalog Service
    const productCatalog = this.createService('product-catalog', {
      image: 'ghcr.io/open-telemetry/demo:latest-product-catalog',
      port: 3550,
      cpu: 256,
      memory: 512,
      environment: {
        FLAGD_HOST: flagd.domain,
        PRODUCT_CATALOG_PORT: '3550',
        PRODUCT_CATALOG_RELOAD_INTERVAL: '10',
        GOMEMLIMIT: '16MiB',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'product-catalog',
      }
    });

    // Payment Service
    const payment = this.createService('payment', {
      image: 'ghcr.io/open-telemetry/demo:latest-payment',
      port: 50051,
      cpu: 256,
      memory: 512,
      environment: {
        FLAGD_HOST: flagd.domain,
        PAYMENT_PORT: '50051',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'payment',
      }
    });

    // Quote Service
    const quote = this.createService('quote', {
      image: 'ghcr.io/open-telemetry/demo:latest-quote',
      port: 8090,
      cpu: 256,
      memory: 512,
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://otel-collector.${DOMAIN_NAME}:4318`,
        OTEL_PHP_AUTOLOAD_ENABLED: 'true',
        QUOTE_PORT: '8090',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'quote',
        OTEL_PHP_INTERNAL_METRICS_ENABLED: 'true',
      }
    });

    // Shipping Service
    const shipping = this.createService('shipping', {
      image: 'ghcr.io/open-telemetry/demo:latest-shipping',
      port: 50050,
      cpu: 256,
      memory: 512,
      environment: {
        SHIPPING_PORT: '50050',
        QUOTE_ADDR: `${quote.domain}:${quote.port}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'shipping',
      }
    });

    // Recommendation Service
    const recommendation = this.createService('recommendation', {
      image: 'ghcr.io/open-telemetry/demo:latest-recommendation',
      port: 9001,
      cpu: 256,
      memory: 512,
      environment: {
        FLAGD_HOST: flagd.domain,
        RECOMMENDATION_PORT: '9001',
        PRODUCT_CATALOG_ADDR: `${productCatalog.domain}:${productCatalog.port}`,
        OTEL_PYTHON_LOG_CORRELATION: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'recommendation',
        PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python',
      }
    });

    // Checkout Service
    const checkout = this.createService('checkout', {
      image: 'ghcr.io/open-telemetry/demo:latest-checkout',
      port: 5050,
      cpu: 256,
      memory: 512,
      environment: {
        CHECKOUT_PORT: '5050',
        CART_ADDR: `${cart.domain}:${cart.port}`,
        CURRENCY_ADDR: `${currency.domain}:${currency.port}`,
        EMAIL_ADDR: `${email.domain}:${email.port}`,
        FLAGD_HOST: flagd.domain,
        PAYMENT_ADDR: `${payment.domain}:${payment.port}`,
        PRODUCT_CATALOG_ADDR: `${productCatalog.domain}:${productCatalog.port}`,
        SHIPPING_ADDR: `${shipping.domain}:${shipping.port}`,
        GOMEMLIMIT: '16MiB',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'checkout',
      }
    });

    // Frontend Service
    const frontend = this.createService('frontend', {
      image: 'ghcr.io/open-telemetry/demo:latest-frontend',
      port: 8080,
      cpu: 512,
      memory: 1024,
      publicLoadBalancer: true,
      environment: {
        PORT: '8080',
        FRONTEND_ADDR: `frontend.${DOMAIN_NAME}:8080`,
        AD_ADDR: `${ad.domain}:${ad.port}`,
        CART_ADDR: `${cart.domain}:${cart.port}`,
        CHECKOUT_ADDR: `checkout.${DOMAIN_NAME}:5050`,
        CURRENCY_ADDR: `${currency.domain}:${currency.port}`,
        PRODUCT_CATALOG_ADDR: `${productCatalog.domain}:${productCatalog.port}`,
        RECOMMENDATION_ADDR: `${recommendation.domain}:${recommendation.port}`,
        SHIPPING_ADDR: `${shipping.domain}:${shipping.port}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        ENV_PLATFORM: 'local',
        OTEL_SERVICE_NAME: 'frontend',
        PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:8080/otlp-http/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        WEB_OTEL_SERVICE_NAME: 'frontend-web',
        OTEL_COLLECTOR_HOST: otelCollector.domain,
        FLAGD_HOST: flagd.domain,
        FLAGD_PORT: `${flagd.port}`,
      }
    });

    // Load Generator
    const loadGenerator = this.createService('load-generator', {
      image: 'ghcr.io/open-telemetry/demo:latest-load-generator',
      port: 8089,
      cpu: 256,
      memory: 512,
      environment: {
        LOCUST_WEB_PORT: '8089',
        LOCUST_USERS: '5',
        LOCUST_HOST: `http://frontend-proxy.${DOMAIN_NAME}:8080`,
        LOCUST_HEADLESS: 'false',
        LOCUST_AUTOSTART: 'true',
        LOCUST_BROWSER_TRAFFIC_ENABLED: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${otelCollector.domain}:${otelCollector.port}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'load-generator',
        PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python',
        LOCUST_WEB_HOST: '0.0.0.0',
        FLAGD_HOST: flagd.domain,
        FLAGD_OFREP_PORT: '8016',
      }
    });

    // Image Provider
    const imageProvider = this.createService('image-provider', {
      image: 'ghcr.io/open-telemetry/demo:latest-image-provider',
      port: 8081,
      cpu: 256,
      memory: 512,
      environment: {
        IMAGE_PROVIDER_PORT: '8081',
        OTEL_COLLECTOR_HOST: otelCollector.domain,
        OTEL_COLLECTOR_PORT_GRPC: '4317',
        OTEL_SERVICE_NAME: 'image-provider',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
      }
    });
    const frontendProxy = this.createService('frontend-proxy', {
      image: 'ghcr.io/open-telemetry/demo:latest-frontend-proxy',
      port: 8080,
      cpu: 256,
      memory: 512,
      environment: {
        FRONTEND_PORT: `${frontend.port}`,
        FRONTEND_HOST: frontend.domain,
        LOCUST_WEB_HOST: loadGenerator.domain,
        LOCUST_WEB_PORT: `${loadGenerator.port}`,
        GRAFANA_PORT: `${grafana.port}`,
        GRAFANA_HOST: grafana.domain,
        JAEGER_PORT: `${jaeger.port}`,
        JAEGER_HOST: jaeger.domain,
        OTEL_COLLECTOR_HOST: otelCollector.domain,
        IMAGE_PROVIDER_HOST: imageProvider.domain,
        IMAGE_PROVIDER_PORT: `${imageProvider.port}`,
        OTEL_COLLECTOR_PORT_GRPC: `${otelCollector.port}`,
        OTEL_COLLECTOR_PORT_HTTP: '4318',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=opentelemetry-demo,service.version=2.0.2',
        OTEL_SERVICE_NAME: 'frontend-proxy',
        ENVOY_PORT: `${frontend.port}`,
        FLAGD_HOST: flagd.domain,
        FLAGD_PORT: `${flagd.port}`,
        FLAGD_UI_HOST: flagdUi.domain,
        FLAGD_UI_PORT: `${flagdUi.port}`,
      }
    });
  }

  private createTelemetryServices() {
    // OpenTelemetry Collector
    const otelCollector = this.createService('otel-collector', {
      image: 'ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.128.0',
      port: 4317,
      cpu: 512,
      memory: 1024,
      environment: {
        OTEL_COLLECTOR_HOST: `otel-collector.${DOMAIN_NAME}`,
        OTEL_COLLECTOR_PORT_GRPC: '4317',
        OTEL_COLLECTOR_PORT_HTTP: '4318',
      },
      additionalPorts: [4318] // HTTP port
    });

        // Prometheus
    const prometheus = this.createService('prometheus', {
      image: 'quay.io/prometheus/prometheus:v3.4.2',
      port: 9090,
      cpu: 512,
      memory: 1024,
      publicLoadBalancer: true,
      environment: {}
    });

    // Grafana
    const grafana = this.createService('grafana', {
      image: 'grafana/grafana:12.0.2',
      port: 3000,
      cpu: 256,
      memory: 512,
      publicLoadBalancer: true,
      environment: {
        GF_INSTALL_PLUGINS: 'grafana-opensearch-datasource',
        GF_SECURITY_ADMIN_PASSWORD: 'admin',
      }
    });

    // Jaeger
    const jaeger = this.createService('jaeger', {
      image: 'jaegertracing/all-in-one:1.70.0',
      port: 16686,
      cpu: 512,
      memory: 1024,
      publicLoadBalancer: true,
      environment: {
        COLLECTOR_OTLP_ENABLED: 'true',
        PROMETHEUS_SERVER_URL: `${prometheus.domain}:${prometheus.port}`,
        PROMETHEUS_QUERY_NORMALIZE_CALLS: 'true',
        PROMETHEUS_QUERY_NORMALIZE_DURATION: 'true',
      },
      additionalPorts: [14268, 14250] // Jaeger collector ports
    });
  
    return { otelCollector, prometheus, grafana, jaeger };
  }

  private ecsTaskExecutionRole: iam.Role;

  private createService(name: string, config: {
    image: string;
    port: number;
    cpu: number;
    memory: number;
    environment: Record<string, string>;
    publicLoadBalancer?: boolean;
    additionalPorts?: number[];
  }): DemoService {
    const logGroup = new logs.LogGroup(this, `${name}-logs`, {
      logGroupName: `/ecs/opentelemetry-demo/${name}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, `${name}-task`, {
      cpu: config.cpu,
      memoryLimitMiB: config.memory,
      executionRole: this.ecsTaskExecutionRole,
    });

    const container = taskDefinition.addContainer(name, {
      image: ecs.ContainerImage.fromRegistry(config.image),
      environment: config.environment,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: name,
      }),
    });

    container.addPortMappings({
      containerPort: config.port,
      protocol: ecs.Protocol.TCP,
    });

    // Add additional port mappings if specified
    if (config.additionalPorts) {
      config.additionalPorts.forEach(port => {
        container.addPortMappings({
          containerPort: port,
          protocol: ecs.Protocol.TCP,
        });
      });
    }

    let service: ecs.FargateService | ecsPatterns.ApplicationLoadBalancedFargateService;
    // For all services, create a dedicated security group allowing inbound traffic on their main port
    const sg = new ec2.SecurityGroup(this, `${name}-sg`, {
      vpc: this.vpc,
      description: `${name} service security group`,
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(config.port), `Allow inbound traffic on port ${config.port}`);
    // Add additional ports if specified
    if (config.additionalPorts) {
      config.additionalPorts.forEach(port => {
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), `Allow inbound traffic on port ${port}`);
      });
    }
    const securityGroups: ec2.ISecurityGroup[] = [sg];

    if (config.publicLoadBalancer) {
      // Only for public-facing services
      service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, `${name}-service`, {
        cluster: this.cluster,
        taskDefinition,
        publicLoadBalancer: true,
        listenerPort: config.port,
        serviceName: name,
        desiredCount: 1,
        securityGroups,
      });
      // Output the service endpoint if it's public
      new cdk.CfnOutput(this, `${name}-url`, {
        value: `http://${service.loadBalancer.loadBalancerDnsName}`,
        description: `${name} service URL`,
      });
      // Enable CloudMap for public services as well (optional, for internal DNS)
      (service.service as ecs.FargateService).enableCloudMap({
        name: name,
        cloudMapNamespace: this.cluster.defaultCloudMapNamespace,
      });
      // Custom health check path for Grafana and Prometheus
      if (name === 'grafana') {
        service.targetGroup.configureHealthCheck({
          path: '/login',
        });
      } else if (name === 'prometheus') {
        service.targetGroup.configureHealthCheck({
          path: '/status',
        });
      }
    } else {
      // Internal-only service, no ALB
      service = new ecs.FargateService(this, `${name}-service`, {
        cluster: this.cluster,
        taskDefinition,
        serviceName: name,
        desiredCount: 1,
        securityGroups,
        cloudMapOptions: {
          name: name,
          cloudMapNamespace: this.cluster.defaultCloudMapNamespace,
        },
      });
    }

    this.services.set(name, service);
    return {
      name,
      port: config.port,
      domain: `${name}.${DOMAIN_NAME}`,
      service,
    };
  }
}
