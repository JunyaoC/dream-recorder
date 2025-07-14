FROM alpine:latest

RUN apk --no-cache add curl

WORKDIR /app

COPY check_alarm.sh /app/check_alarm.sh
COPY crontab /etc/crontabs/root

RUN chmod +x /app/check_alarm.sh

CMD ["crond", "-f", "-L", "/dev/stdout"] 