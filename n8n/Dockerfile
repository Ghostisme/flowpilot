FROM n8nio/n8n:2.38.1

USER root
COPY workflows /opt/flowpilot/workflows
COPY docker-entrypoint.sh /opt/flowpilot/docker-entrypoint.sh
RUN chmod +x /opt/flowpilot/docker-entrypoint.sh \
  && chown -R node:node /opt/flowpilot
USER node

EXPOSE 5678
ENTRYPOINT ["/bin/sh", "/opt/flowpilot/docker-entrypoint.sh"]
