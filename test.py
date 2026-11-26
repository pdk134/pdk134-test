import re
phone = "13812345678"
print(phone)

if re.match(1, phone):
    print("手机号格式正确")
else:
    print("手机号格式错误")