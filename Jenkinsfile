// FlowPilot 部署流水线
//
// 形态：Jenkins 从 GitHub 拉代码 → 在 VPS 本机构建两个镜像 → 换掉旧容器。
// 镜像只存在本机 Docker，不推远端 registry（单机部署没有拉取方）。
//
// 产出两个容器：
//   flowpilot-api —— NestJS API，监听 127.0.0.1:13001
//   flowpilot-web —— nginx 托管的静态前端，监听 127.0.0.1:13000
//
// 都只绑回环地址，公网入口由宿主机 nginx 在 flowpilot.darkrich.com
// 按路径分流（/ → web，/api → api）。前后端同源，无跨域。
//
// 注意 API 的路由前缀：main.ts 里 setGlobalPrefix("api")，即容器内真实路径
// 是 /api/xxx。宿主机 nginx 转发时必须保留 /api 前缀，不要 strip。
//
// 前置条件：
//   1. Jenkins 执行用户能访问 Docker daemon。
//   2. 已建好 Secret file 凭据 flowpilot-env。
//   3. docker network create appnet 已执行。
//   4. PostgreSQL 的 flowpilot 库与账号已初始化（见 deploy/db-init 说明）。
//
// 分支策略（多分支流水线）：
//   main     —— 构建 + 部署 + 健康检查，即线上环境。
//   其它分支 —— 只构建，验证「这个分支能否成功打出镜像」，不碰任何线上容器。
// 部署相关的 stage 全部带 when 守卫，见下方 isProduction()。

// ---------------------------------------------------------------------------
// 多分支支持
//
// 多分支流水线会为每个分支各建一条子流水线，并注入 BRANCH_NAME。
// 经典 Pipeline 任务没有这个变量，此处回退成 main，让同一份文件在两种
// 任务类型下都能正常工作（迁移任务类型时不需要改 Jenkinsfile）。
// ---------------------------------------------------------------------------

/** 当前分支名。经典 Pipeline 任务下回退为 main。 */
String branchName() {
  return env.BRANCH_NAME ?: 'main'
}

/** 是否为生产分支。只有生产分支允许改动线上容器。 */
boolean isProduction() {
  return branchName() == 'main'
}

/**
 * 镜像标签。
 *
 * main 用纯构建号，维持「数字 tag = 可回滚的生产版本」这一约定 ——
 * 清理阶段用 ^[0-9]+$ 过滤要删的旧版本，特性分支的 tag 必须落在这个集合之外，
 * 否则会被当成旧的生产版本误删。
 *
 * 其它分支加分支名前缀：多分支流水线的 BUILD_NUMBER 是【每分支独立计数】的，
 * 不加前缀时 feature-a 的 #1 和 feature-b 的 #1 会抢同一个 tag。
 */
String imageTag() {
  if (isProduction()) {
    return env.BUILD_NUMBER
  }
  // Docker tag 合法字符集是 [A-Za-z0-9_.-]，feature/xxx 这类分支名含 / 必须转义。
  return branchName().replaceAll('[^A-Za-z0-9._-]', '-') + '-' + env.BUILD_NUMBER
}

pipeline {
  agent any

  options {
    timestamps()
    // pnpm 安装 monorepo 依赖 + 两次 Next 构建，耗时较长。
    timeout(time: 40, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
    disableConcurrentBuilds()
  }

  environment {
    APP           = 'flowpilot'
    NETWORK       = 'appnet'

    API_IMAGE     = 'flowpilot-api'
    WEB_IMAGE     = 'flowpilot-web'
    API_CONTAINER = 'flowpilot-api'
    WEB_CONTAINER = 'flowpilot-web'

    API_HOST_PORT = '13001'
    WEB_HOST_PORT = '13000'

    PUBLIC_DOMAIN = 'flowpilot.darkrich.com'

    TAG           = "${imageTag()}"
  }

  stages {

    stage('检出代码') {
      steps {
        checkout scm
        sh 'git log -1 --pretty="提交: %h %an %s"'
      }
    }

    stage('构建 API 镜像') {
      steps {
        // 复用仓库根 Dockerfile 的 api target。上下文必须是仓库根：
        // apps/api 依赖 workspace 包 @flowpilot/contracts。
        sh '''
          set -eu
          docker build \
            -f Dockerfile \
            --target api \
            -t "${API_IMAGE}:${TAG}" \
            -t "${API_IMAGE}:latest" \
            .
        '''
      }
    }

    stage('构建 Web 镜像') {
      steps {
        // 用 Dockerfile.web-static 而非根 Dockerfile 的 web target：
        // 后者跑 next start（Node 运行时），前者静态导出交给 nginx，符合
        // 「前端只用 nginx 镜像」的部署约定。
        //
        // NEXT_PUBLIC_API_BASE 构建期烘进 bundle，运行时无法改，必须在此定值。
        sh '''
          set -eu
          docker build \
            -f Dockerfile.web-static \
            --build-arg NEXT_PUBLIC_API_BASE=/api \
            --build-arg NEXT_PUBLIC_EVENT_TRANSPORT=sse \
            -t "${WEB_IMAGE}:${TAG}" \
            -t "${WEB_IMAGE}:latest" \
            .
        '''
      }
    }

    stage('部署 API') {
      // 容器名与宿主机端口都是硬编码的单例，非生产分支一旦执行就会顶掉线上服务。
      when { expression { isProduction() } }
      steps {
        withCredentials([file(credentialsId: 'flowpilot-env', variable: 'ENV_FILE')]) {
          sh '''
            set -eu
            docker rm -f "${API_CONTAINER}" 2>/dev/null || true

            docker run -d \
              --name "${API_CONTAINER}" \
              --network "${NETWORK}" \
              --restart unless-stopped \
              --env-file "${ENV_FILE}" \
              -e PORT=3001 \
              -p 127.0.0.1:${API_HOST_PORT}:3001 \
              --log-opt max-size=10m --log-opt max-file=3 \
              "${API_IMAGE}:${TAG}"
          '''
        }
      }
    }

    stage('部署 Web') {
      when { expression { isProduction() } }
      steps {
        sh '''
          set -eu
          docker rm -f "${WEB_CONTAINER}" 2>/dev/null || true

          docker run -d \
            --name "${WEB_CONTAINER}" \
            --network "${NETWORK}" \
            --restart unless-stopped \
            -p 127.0.0.1:${WEB_HOST_PORT}:80 \
            --log-opt max-size=10m --log-opt max-file=3 \
            "${WEB_IMAGE}:${TAG}"
        '''
      }
    }

    stage('健康检查') {
      // 探的是线上端口，非生产分支根本没部署，跑这一步只会探到上一次 main 的结果，
      // 给出虚假的绿灯。
      when { expression { isProduction() } }
      steps {
        sh '''
          set -eu

          wait_http() {
            name="$1"; url="$2"
            for i in $(seq 1 30); do
              if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
                echo "✅ ${name} 就绪: ${url}"
                return 0
              fi
              sleep 2
            done
            echo "❌ ${name} 在 60 秒内未就绪: ${url}"
            return 1
          }

          # health.controller.ts 的 @Controller("health") 叠加全局前缀 api，
          # 实际路径为 /api/health。
          wait_http "API" "http://127.0.0.1:${API_HOST_PORT}/api/health" || {
            echo "--- ${API_CONTAINER} 最近日志 ---"
            docker logs --tail 80 "${API_CONTAINER}" || true
            exit 1
          }

          wait_http "Web" "http://127.0.0.1:${WEB_HOST_PORT}/" || {
            echo "--- ${WEB_CONTAINER} 最近日志 ---"
            docker logs --tail 80 "${WEB_CONTAINER}" || true
            exit 1
          }
        '''
      }
    }

    stage('清理旧镜像') {
      // 只有生产分支会累积「需要保留最近几个版本以便回滚」的镜像序列；
      // 特性分支的镜像由下面 post 块的 always 统一收掉。
      when { expression { isProduction() } }
      steps {
        // 每次构建产生新 tag，不清理磁盘会被吃满。各保留最近 3 个版本以便回滚。
        sh '''
          set -eu
          for img in "${API_IMAGE}" "${WEB_IMAGE}"; do
            docker images "$img" --format '{{.Tag}}' | grep -E '^[0-9]+$' | sort -rn | tail -n +4 \
              | xargs -r -I{} docker rmi -f "$img:{}" 2>/dev/null || true
          done
          docker image prune -f >/dev/null 2>&1 || true
        '''
      }
    }
  }

  post {
    success {
      script {
        if (isProduction()) {
          echo "✅ ${APP} #${TAG} 部署成功 → https://${PUBLIC_DOMAIN}"
        } else {
          echo "✅ ${APP} 分支 ${branchName()} 构建通过（镜像 tag ${TAG}），未部署 —— 只有 main 会上线。"
        }
      }
    }
    failure {
      script {
        if (isProduction()) {
          echo "❌ ${APP} #${TAG} 部署失败。失败可能发生在替换容器之后，线上此刻未必可用。"
          sh '''
            echo "--- 当前容器状态 ---"
            docker ps -a --filter "name=flowpilot" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
          '''
        } else {
          echo "❌ ${APP} 分支 ${branchName()} 构建失败（未触碰线上容器）。"
        }
      }
    }
    always {
      // 特性分支的镜像不进「保留最近 3 个」的回滚序列，用完即弃；
      // 不清理的话每推一次分支就多两层镜像，磁盘很快见底。
      script {
        if (!isProduction()) {
          sh '''
            set -eu
            docker rmi -f "${API_IMAGE}:${TAG}" "${WEB_IMAGE}:${TAG}" 2>/dev/null || true
            docker image prune -f >/dev/null 2>&1 || true
          '''
        }
      }
    }
  }
}
