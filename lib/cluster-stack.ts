import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, Ec2Service, Ec2TaskDefinition, LogDrivers, Secret } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class PgadminClusterStack extends Stack  {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'appvpc', {
      cidr: "10.10.0.0/16",
      vpcName: 'appvpc',

      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet-1',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-app-subnet-1',
          subnetType: SubnetType.PRIVATE_WITH_NAT,
        },
        {
          cidrMask: 24,
          name: 'private-db-subnet-1',
          subnetType: SubnetType.PRIVATE_ISOLATED,
        }
      ]
    });

    // Create an ECS cluster
    const cluster = new Cluster(this, 'Cluster', {vpc});

    // Add capacity to it
    cluster.addCapacity('DefaultAutoScalingGroupCapacity', {
      instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.SMALL)
    });

    // Create pgadmin secrets
    const email = "hello@myorg.lab";
    const pgadminSecret = new secretsmanager.Secret(this, 'pgadmin-secret', {
      secretName: 'pgadmin-secret',
      description: 'Pgadmin Credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({email:email}),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }      
    });

    //  Create TaskDef
    const taskDefinition = new Ec2TaskDefinition(this, 'TaskDef', {});

    const container = taskDefinition.addContainer('pgadminContainer', {
      image: ContainerImage.fromRegistry('dpage/pgadmin4'),
      memoryLimitMiB: 256,
      cpu: 256,
      portMappings: [{
        containerPort: 80,
        hostPort: 80
      }],
      secrets: {
        PGADMIN_DEFAULT_EMAIL: Secret.fromSecretsManager(pgadminSecret, 'email'),
        PGADMIN_DEFAULT_PASSWORD: Secret.fromSecretsManager(pgadminSecret, 'password')
      },
      logging: LogDrivers.awsLogs({streamPrefix: 'pgadmin-service'}),
    });

    // Instantiate an Amazon ECS Service
    const ecsService = new Ec2Service(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1
    });

    // The service is deployed in a Private Subnet.  We need someway of accessing it externally.  We need a Load Balancer.
    const alb = new ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true
    });

    const listener = alb.addListener('pgadmin-listener', {
      port: 80
    });

    listener.addTargets('pgadmin-target', {
      port: 80,
      targets: [ecsService],
      protocol: ApplicationProtocol.HTTP,
      healthCheck: {
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        timeout: Duration.seconds(20),
        interval: Duration.seconds(30)
      }
    });

    new CfnOutput(this, 'alb-url', {
      value: alb.loadBalancerDnsName,
      exportName: 'pgadmin-stack-loadBalancerDnsName'
    });
  }
}